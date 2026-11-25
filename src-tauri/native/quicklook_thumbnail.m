#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreImage/CoreImage.h>
#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#import <QuickLook/QuickLook.h>
#import <Vision/Vision.h>

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static BOOL imageexplorer_is_raw_extension(NSString *extension) {
    static NSSet<NSString *> *rawExtensions = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        rawExtensions = [NSSet setWithObjects:
            @"arw", @"cr2", @"cr3", @"nef", @"nrw", @"raf", @"orf", @"rw2",
            @"pef", @"srw", @"dcr", @"kdc", @"3fr", @"iiq", @"x3f", @"dng", nil
        ];
    });
    return extension != nil && [rawExtensions containsObject:extension.lowercaseString];
}

static CIContext *imageexplorer_shared_ci_context(void) {
    static CIContext *sharedContext = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        sharedContext = [CIContext contextWithOptions:@{
            kCIContextUseSoftwareRenderer: @NO,
            kCIContextHighQualityDownsample: @YES,
        }];
    });
    return sharedContext;
}

static uint16_t imageexplorer_tiff_u16(const uint8_t *bytes, BOOL littleEndian) {
    return littleEndian ? (uint16_t)(bytes[0] | bytes[1] << 8)
                        : (uint16_t)(bytes[0] << 8 | bytes[1]);
}

static uint32_t imageexplorer_tiff_u32(const uint8_t *bytes, BOOL littleEndian) {
    return littleEndian
        ? (uint32_t)bytes[0] | (uint32_t)bytes[1] << 8 | (uint32_t)bytes[2] << 16 | (uint32_t)bytes[3] << 24
        : (uint32_t)bytes[0] << 24 | (uint32_t)bytes[1] << 16 | (uint32_t)bytes[2] << 8 | (uint32_t)bytes[3];
}

// Return the camera's original JPEG bytes. The Quick Look image can then stay
// at native resolution without repeatedly PNG-encoding a new frame on zoom.
uint8_t *imageexplorer_arw_embedded_jpeg(const char *path, uint32_t maxPixelSize, size_t *length) {
    if (path == NULL || length == NULL) return NULL;
    *length = 0;
    @autoreleasepool {
        NSString *filePath = [NSString stringWithUTF8String:path];
        if (filePath == nil || ![filePath.pathExtension.lowercaseString isEqualToString:@"arw"]) return NULL;
        NSData *file = [NSData dataWithContentsOfFile:filePath options:NSDataReadingMappedIfSafe error:nil];
        if (file.length < 8) return NULL;
        const uint8_t *bytes = file.bytes;
        BOOL littleEndian = bytes[0] == 'I' && bytes[1] == 'I';
        if (!littleEndian && !(bytes[0] == 'M' && bytes[1] == 'M')) return NULL;
        if (imageexplorer_tiff_u16(bytes + 2, littleEndian) != 42) return NULL;

        uint32_t ifd = imageexplorer_tiff_u32(bytes + 4, littleEndian);
        uint32_t bestOffset = 0, bestLength = 0;
        for (int depth = 0; depth < 16 && ifd != 0; depth++) {
            if ((uint64_t)ifd + 2 > file.length) break;
            uint16_t count = imageexplorer_tiff_u16(bytes + ifd, littleEndian);
            uint64_t end = (uint64_t)ifd + 2 + (uint64_t)count * 12 + 4;
            if (end > file.length) break;
            uint32_t jpegOffset = 0, jpegLength = 0;
            for (uint16_t entry = 0; entry < count; entry++) {
                const uint8_t *tag = bytes + ifd + 2 + (uint64_t)entry * 12;
                uint16_t id = imageexplorer_tiff_u16(tag, littleEndian);
                if ((id == 0x0201 || id == 0x0202) &&
                    imageexplorer_tiff_u16(tag + 2, littleEndian) == 4 &&
                    imageexplorer_tiff_u32(tag + 4, littleEndian) == 1) {
                    uint32_t value = imageexplorer_tiff_u32(tag + 8, littleEndian);
                    if (id == 0x0201) jpegOffset = value;
                    else jpegLength = value;
                }
            }
            if (jpegLength > bestLength && jpegLength >= 100000 &&
                (uint64_t)jpegOffset + jpegLength <= file.length &&
                bytes[jpegOffset] == 0xff && bytes[jpegOffset + 1] == 0xd8) {
                bestOffset = jpegOffset;
                bestLength = jpegLength;
            }
            ifd = imageexplorer_tiff_u32(bytes + end - 4, littleEndian);
        }
        if (!bestLength) return NULL;
        if (maxPixelSize > 0) {
            NSData *jpeg = [NSData dataWithBytesNoCopy:(void *)(bytes + bestOffset)
                                                length:bestLength
                                          freeWhenDone:NO];
            CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)jpeg, NULL);
            if (source != NULL) {
                NSDictionary *properties = CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(source, 0, NULL));
                NSNumber *pixelWidth = properties[(id)kCGImagePropertyPixelWidth];
                NSNumber *pixelHeight = properties[(id)kCGImagePropertyPixelHeight];
                if (MAX(pixelWidth.unsignedIntegerValue, pixelHeight.unsignedIntegerValue) > maxPixelSize) {
                    NSDictionary *options = @{
                        (id)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
                        (id)kCGImageSourceCreateThumbnailWithTransform: @YES,
                        (id)kCGImageSourceThumbnailMaxPixelSize: @(maxPixelSize),
                    };
                    CGImageRef image = CGImageSourceCreateThumbnailAtIndex(source, 0, (__bridge CFDictionaryRef)options);
                    if (image != NULL) {
                        CFMutableDataRef data = CFDataCreateMutable(kCFAllocatorDefault, 0);
                        CGImageDestinationRef destination = data == NULL ? NULL :
                            CGImageDestinationCreateWithData(data, CFSTR("public.jpeg"), 1, NULL);
                        if (destination != NULL) {
                            NSDictionary *encodeOptions = @{(id)kCGImageDestinationLossyCompressionQuality: @0.9};
                            CGImageDestinationAddImage(destination, image, (__bridge CFDictionaryRef)encodeOptions);
                            if (CGImageDestinationFinalize(destination)) {
                                CFIndex dataLength = CFDataGetLength(data);
                                uint8_t *result = malloc((size_t)dataLength);
                                if (result != NULL) {
                                    CFDataGetBytes(data, CFRangeMake(0, dataLength), result);
                                    *length = (size_t)dataLength;
                                }
                                CFRelease(destination);
                                CFRelease(data);
                                CGImageRelease(image);
                                CFRelease(source);
                                (void)file;
                                return result;
                            }
                            CFRelease(destination);
                        }
                        if (data != NULL) CFRelease(data);
                        CGImageRelease(image);
                    }
                }
                CFRelease(source);
            }
            (void)file;
        }
        uint8_t *result = malloc(bestLength);
        if (result == NULL) return NULL;
        memcpy(result, bytes + bestOffset, bestLength);
        *length = bestLength;
        return result;
    }
}

// Sony ARW stores a full-resolution JPEG in a later TIFF IFD. ImageIO's
// thumbnail API instead picks the much smaller 1616px camera preview, which
// loses the focus difference between nearby parts of a small subject.
static CGImageRef imageexplorer_create_arw_full_jpeg(NSURL *fileURL, uint32_t size) {
    if (![fileURL.pathExtension.lowercaseString isEqualToString:@"arw"]) return NULL;
    NSData *file = [NSData dataWithContentsOfURL:fileURL options:NSDataReadingMappedIfSafe error:nil];
    if (file.length < 8) return NULL;
    const uint8_t *bytes = file.bytes;
    BOOL littleEndian = bytes[0] == 'I' && bytes[1] == 'I';
    if (!littleEndian && !(bytes[0] == 'M' && bytes[1] == 'M')) return NULL;
    if (imageexplorer_tiff_u16(bytes + 2, littleEndian) != 42) return NULL;

    uint32_t ifd = imageexplorer_tiff_u32(bytes + 4, littleEndian);
    uint32_t bestOffset = 0, bestLength = 0;
    for (int depth = 0; depth < 16 && ifd != 0; depth++) {
        if ((uint64_t)ifd + 2 > file.length) break;
        uint16_t count = imageexplorer_tiff_u16(bytes + ifd, littleEndian);
        uint64_t end = (uint64_t)ifd + 2 + (uint64_t)count * 12 + 4;
        if (end > file.length) break;
        uint32_t jpegOffset = 0, jpegLength = 0;
        for (uint16_t entry = 0; entry < count; entry++) {
            const uint8_t *tag = bytes + ifd + 2 + (uint64_t)entry * 12;
            uint16_t id = imageexplorer_tiff_u16(tag, littleEndian);
            if ((id == 0x0201 || id == 0x0202) &&
                imageexplorer_tiff_u16(tag + 2, littleEndian) == 4 &&
                imageexplorer_tiff_u32(tag + 4, littleEndian) == 1) {
                uint32_t value = imageexplorer_tiff_u32(tag + 8, littleEndian);
                if (id == 0x0201) jpegOffset = value;
                else jpegLength = value;
            }
        }
        if (jpegLength > bestLength && jpegLength >= 100000 &&
            (uint64_t)jpegOffset + jpegLength <= file.length &&
            bytes[jpegOffset] == 0xff && bytes[jpegOffset + 1] == 0xd8) {
            bestOffset = jpegOffset;
            bestLength = jpegLength;
        }
        ifd = imageexplorer_tiff_u32(bytes + end - 4, littleEndian);
    }
    if (!bestLength) return NULL;

    NSData *jpeg = [NSData dataWithBytesNoCopy:(void *)(bytes + bestOffset)
                                        length:bestLength
                                  freeWhenDone:NO];
    CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)jpeg, NULL);
    if (source == NULL) return NULL;
    NSDictionary *options = @{
        (id)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
        (id)kCGImageSourceCreateThumbnailWithTransform: @YES,
        (id)kCGImageSourceThumbnailMaxPixelSize: @(size),
    };
    CGImageRef image = CGImageSourceCreateThumbnailAtIndex(source, 0, (__bridge CFDictionaryRef)options);
    CFRelease(source);
    (void)file;
    return image;
}

static CGImageRef imageexplorer_create_imageio_preview(NSURL *fileURL, uint32_t size) {
    CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)fileURL, NULL);
    if (source == NULL) {
        return NULL;
    }

    NSDictionary *options = @{
        // Force ImageIO to decode the source instead of returning a small embedded
        // camera thumbnail. This is the part that makes RAW previews comparable to
        // Finder Quick Look rather than merely enlarging a low-resolution preview.
        (id)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
        (id)kCGImageSourceCreateThumbnailWithTransform: @YES,
        (id)kCGImageSourceThumbnailMaxPixelSize: @(size),
        (id)kCGImageSourceShouldCacheImmediately: @YES,
    };
    CGImageRef image = CGImageSourceCreateThumbnailAtIndex(
        source,
        0,
        (__bridge CFDictionaryRef)options
    );
    CFRelease(source);
    return image;
}

// ImageIO's RAW thumbnail path is allowed to choose a camera-embedded JPEG on
// some macOS/RAW decoder combinations even when a large max pixel size was
// requested. CIRAWFilter is the explicit sensor-data path: it reports the
// native RAW size and renders a size-bounded demosaiced image instead of
// enlarging the embedded preview.
static CGImageRef imageexplorer_create_coreimage_raw_preview(NSURL *fileURL, uint32_t size) {
    if (!imageexplorer_is_raw_extension(fileURL.pathExtension)) {
        return NULL;
    }

    // Avoid Objective-C `@available(...)` here: Clang emits a reference to
    // `___isPlatformVersionAtLeast` from `libclang_rt.osx.a`, which is not
    // linked when Rust invokes `cc -nodefaultlibs` for release bundles.
    NSOperatingSystemVersion minVersion = { 12, 0, 0 };
    if (![[NSProcessInfo processInfo] isOperatingSystemAtLeastVersion:minVersion]) {
        return NULL;
    }
    Class rawFilterClass = NSClassFromString(@"CIRAWFilter");
    if (rawFilterClass == Nil) {
        return NULL;
    }

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunguarded-availability-new"
    CIRAWFilter *rawFilter = [rawFilterClass filterWithImageURL:fileURL];
    if (rawFilter == nil || rawFilter.nativeSize.width <= 0 || rawFilter.nativeSize.height <= 0) {
        return NULL;
    }

    NSNumber *orientationValue = rawFilter.properties[(NSString *)kCGImagePropertyOrientation];
    if (orientationValue != nil) {
        NSInteger orientation = orientationValue.integerValue;
        if (orientation >= 1 && orientation <= 8) {
            rawFilter.orientation = (CGImagePropertyOrientation)orientation;
        }
    }

    CGFloat nativeMax = MAX(rawFilter.nativeSize.width, rawFilter.nativeSize.height);
    CGFloat scale = MIN(1.0, (CGFloat)size / nativeMax);
    rawFilter.scaleFactor = MAX(0.01, scale);
    rawFilter.draftModeEnabled = NO;

    CIImage *outputImage = rawFilter.outputImage;
    if (outputImage == nil) {
        return NULL;
    }

    CIContext *context = imageexplorer_shared_ci_context();
    if (context == nil) {
        return NULL;
    }

    return [context createCGImage:outputImage fromRect:outputImage.extent];
#pragma clang diagnostic pop
}

static CGImageRef imageexplorer_create_embedded_preview(NSURL *fileURL, uint32_t size) {
    CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)fileURL, NULL);
    if (source == NULL) {
        return NULL;
    }

    NSDictionary *options = @{
        // Some RAW files expose only the camera-embedded JPEG. It is still a
        // valid visual input for grouping when full RAW decoding is unavailable.
        (id)kCGImageSourceCreateThumbnailFromImageIfAbsent: @NO,
        (id)kCGImageSourceCreateThumbnailWithTransform: @YES,
        (id)kCGImageSourceThumbnailMaxPixelSize: @(size),
        (id)kCGImageSourceShouldCacheImmediately: @YES,
    };
    CGImageRef image = CGImageSourceCreateThumbnailAtIndex(
        source,
        0,
        (__bridge CFDictionaryRef)options
    );
    CFRelease(source);
    return image;
}

static CGImageRef imageexplorer_create_quicklook_preview(NSURL *fileURL, uint32_t size) {
    return QLThumbnailImageCreate(
        kCFAllocatorDefault,
        (__bridge CFURLRef)fileURL,
        CGSizeMake((CGFloat)size, (CGFloat)size),
        NULL
    );
}

// Generate a high-resolution PNG in-process. This avoids spawning one qlmanage
// process for every RAW file in a large directory.
uint8_t *imageexplorer_quicklook_thumbnail(
    const char *path,
    uint32_t size,
    int preferEmbedded,
    size_t *length
) {
    if (path == NULL || length == NULL || size == 0) {
        return NULL;
    }

    *length = 0;

    @autoreleasepool {
        NSString *filePath = [NSString stringWithUTF8String:path];
        if (filePath == nil) {
            return NULL;
        }

        NSURL *fileURL = [NSURL fileURLWithPath:filePath];
        BOOL isRaw = imageexplorer_is_raw_extension(fileURL.pathExtension);
        // Grid thumbnails and focus analysis should use the camera-embedded JPEG
        // for RAW files whenever possible. Non-RAW formats decode directly via
        // ImageIO's size-bounded thumbnail API so stale tiny EXIF thumbnails
        // are never enlarged and external `sips` processes are not needed.
        CGImageRef image = NULL;
        if (isRaw) {
            if (preferEmbedded) {
                image = imageexplorer_create_arw_full_jpeg(fileURL, size);
                // A few ARWs omit the full JPEG. Keep the high-resolution RAW
                // path for those files rather than enlarging a small thumbnail.
                if (image == NULL && size >= 2048 && [fileURL.pathExtension.lowercaseString isEqualToString:@"arw"]) {
                    image = imageexplorer_create_coreimage_raw_preview(fileURL, size);
                }
                if (image == NULL) {
                    image = imageexplorer_create_embedded_preview(fileURL, size);
                }
                if (image == NULL) {
                    image = imageexplorer_create_imageio_preview(fileURL, size);
                }
            } else {
                // Full sensor CIRAWFilter demosaicing serializes on CoreImage's internal
                // CIContext mutex (~1s/frame). Reserve it strictly for large Quick Look
                // requests (>= 1600px) and use fast ImageIO/embedded previews for thumbnails.
                if (size >= 1600) {
                    image = imageexplorer_create_coreimage_raw_preview(fileURL, size);
                }
                if (image == NULL) {
                    image = imageexplorer_create_arw_full_jpeg(fileURL, size);
                }
                if (image == NULL) {
                    image = imageexplorer_create_imageio_preview(fileURL, size);
                }
            }
        } else {
            image = imageexplorer_create_imageio_preview(fileURL, size);
        }
        if (image == NULL) {
            image = imageexplorer_create_quicklook_preview(fileURL, size);
        }
        if (image == NULL) {
            return NULL;
        }

        CFMutableDataRef data = CFDataCreateMutable(kCFAllocatorDefault, 0);
        if (data == NULL) {
            CGImageRelease(image);
            return NULL;
        }

        // Encode opaque photos as JPEG (5-15x smaller and much faster to encode
        // than PNG) while preserving PNG for images with an alpha channel.
        CGImageAlphaInfo alphaInfo = CGImageGetAlphaInfo(image);
        BOOL hasAlpha = alphaInfo != kCGImageAlphaNone &&
                        alphaInfo != kCGImageAlphaNoneSkipFirst &&
                        alphaInfo != kCGImageAlphaNoneSkipLast;
        CFStringRef outputType = hasAlpha ? CFSTR("public.png") : CFSTR("public.jpeg");
        CGImageDestinationRef destination = CGImageDestinationCreateWithData(
            data,
            outputType,
            1,
            NULL
        );
        if (destination == NULL) {
            CFRelease(data);
            CGImageRelease(image);
            return NULL;
        }

        CGFloat jpegQuality = size >= 1600 ? 0.94 : 0.86;
        NSDictionary *encodeOptions = hasAlpha
            ? nil
            : @{(id)kCGImageDestinationLossyCompressionQuality: @(jpegQuality)};
        CGImageDestinationAddImage(destination, image, (__bridge CFDictionaryRef)encodeOptions);
        if (!CGImageDestinationFinalize(destination)) {
            if (destination != NULL) {
                CFRelease(destination);
            }
            CFRelease(data);
            CGImageRelease(image);
            return NULL;
        }

        CFIndex dataLength = CFDataGetLength(data);
        uint8_t *result = malloc((size_t)dataLength);
        if (result != NULL) {
            CFDataGetBytes(data, CFRangeMake(0, dataLength), result);
            *length = (size_t)dataLength;
        }

        CFRelease(destination);
        CFRelease(data);
        CGImageRelease(image);
        return result;
    }
}

void imageexplorer_free_thumbnail(uint8_t *buffer) {
    free(buffer);
}

// Orientation-correct and optionally downscale an already-extracted JPEG buffer
// using ImageIO. Returns NULL when the JPEG is already within `maxPixelSize`
// and has normal orientation so the caller can return the original bytes
// untouched with zero re-encoding overhead.
uint8_t *imageexplorer_resize_jpeg_bytes(
    const uint8_t *jpegBytes,
    size_t jpegLength,
    uint32_t maxPixelSize,
    size_t *outLength
) {
    if (jpegBytes == NULL || jpegLength == 0 || outLength == NULL) {
        return NULL;
    }
    *outLength = 0;

    @autoreleasepool {
        NSData *input = [NSData dataWithBytesNoCopy:(void *)jpegBytes
                                             length:jpegLength
                                       freeWhenDone:NO];
        CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)input, NULL);
        if (source == NULL) {
            return NULL;
        }

        NSDictionary *properties = CFBridgingRelease(
            CGImageSourceCopyPropertiesAtIndex(source, 0, NULL)
        );
        NSNumber *pixelWidth = properties[(id)kCGImagePropertyPixelWidth];
        NSNumber *pixelHeight = properties[(id)kCGImagePropertyPixelHeight];
        NSNumber *orientationNumber = properties[(id)kCGImagePropertyOrientation];
        NSUInteger maxDim = MAX(pixelWidth.unsignedIntegerValue, pixelHeight.unsignedIntegerValue);
        NSInteger orientation = orientationNumber != nil ? orientationNumber.integerValue : 1;

        BOOL needsResize = maxPixelSize > 0 && maxDim > maxPixelSize;
        BOOL needsTransform = orientation > 1 && orientation <= 8;
        if (!needsResize && !needsTransform) {
            CFRelease(source);
            return NULL;
        }

        uint32_t targetMax = needsResize ? maxPixelSize : (uint32_t)MAX(maxDim, (NSUInteger)1);
        NSDictionary *options = @{
            (id)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
            (id)kCGImageSourceCreateThumbnailWithTransform: @YES,
            (id)kCGImageSourceThumbnailMaxPixelSize: @(targetMax),
        };
        CGImageRef image = CGImageSourceCreateThumbnailAtIndex(
            source,
            0,
            (__bridge CFDictionaryRef)options
        );
        CFRelease(source);
        if (image == NULL) {
            return NULL;
        }

        CFMutableDataRef data = CFDataCreateMutable(kCFAllocatorDefault, 0);
        CGImageDestinationRef destination = data == NULL
            ? NULL
            : CGImageDestinationCreateWithData(data, CFSTR("public.jpeg"), 1, NULL);
        if (destination == NULL) {
            if (data != NULL) CFRelease(data);
            CGImageRelease(image);
            return NULL;
        }

        NSDictionary *encodeOptions = @{(id)kCGImageDestinationLossyCompressionQuality: @0.95};
        CGImageDestinationAddImage(destination, image, (__bridge CFDictionaryRef)encodeOptions);
        uint8_t *result = NULL;
        if (CGImageDestinationFinalize(destination)) {
            CFIndex dataLength = CFDataGetLength(data);
            if (dataLength > 0) {
                result = malloc((size_t)dataLength);
                if (result != NULL) {
                    CFDataGetBytes(data, CFRangeMake(0, dataLength), result);
                    *outLength = (size_t)dataLength;
                }
            }
        }

        CFRelease(destination);
        CFRelease(data);
        CGImageRelease(image);
        return result;
    }
}

static id imageexplorer_first_value(NSDictionary *dictionary, NSArray<NSString *> *keys) {
    for (NSString *key in keys) {
        id value = dictionary[key];
        if (value != nil && value != [NSNull null]) {
            if ([value isKindOfClass:NSArray.class]) {
                value = [(NSArray *)value firstObject];
            }
            if (value != nil && value != [NSNull null]) {
                return value;
            }
        }
    }
    return nil;
}

static void imageexplorer_set_string_value(
    NSMutableDictionary *dictionary,
    NSString *key,
    id value
) {
    if (value == nil || value == [NSNull null]) {
        return;
    }

    if ([value isKindOfClass:NSString.class]) {
        if ([(NSString *)value length] > 0) {
            dictionary[key] = value;
        }
    } else if ([value isKindOfClass:NSNumber.class]) {
        dictionary[key] = [(NSNumber *)value stringValue];
    }
}

// Read camera metadata through ImageIO instead of Spotlight's mdls importer.
// RAW files often expose exposure time through mdls but keep ISO, F-number,
// focal length, and lens information inside the ImageIO EXIF dictionaries.
uint8_t *imageexplorer_image_metadata(const char *path, size_t *length) {
    if (path == NULL || length == NULL) {
        return NULL;
    }

    *length = 0;

    @autoreleasepool {
        NSString *filePath = [NSString stringWithUTF8String:path];
        if (filePath == nil) {
            return NULL;
        }

        NSURL *fileURL = [NSURL fileURLWithPath:filePath];
        CGImageSourceRef source = CGImageSourceCreateWithURL(
            (__bridge CFURLRef)fileURL,
            NULL
        );
        if (source == NULL) {
            return NULL;
        }

        NSDictionary *properties = CFBridgingRelease(
            CGImageSourceCopyPropertiesAtIndex(source, 0, NULL)
        );
        CFRelease(source);
        if (properties == nil) {
            return NULL;
        }

        NSDictionary *tiff = properties[(NSString *)kCGImagePropertyTIFFDictionary];
        NSDictionary *exif = properties[(NSString *)kCGImagePropertyExifDictionary];
        NSDictionary *exifAux = properties[(NSString *)kCGImagePropertyExifAuxDictionary];
        NSMutableDictionary *metadata = [NSMutableDictionary dictionary];

        id width = properties[(NSString *)kCGImagePropertyPixelWidth];
        id height = properties[(NSString *)kCGImagePropertyPixelHeight];
        if ([width isKindOfClass:NSNumber.class]) {
            metadata[@"width"] = width;
        }
        if ([height isKindOfClass:NSNumber.class]) {
            metadata[@"height"] = height;
        }

        imageexplorer_set_string_value(
            metadata,
            @"make",
            imageexplorer_first_value(tiff, @[(NSString *)kCGImagePropertyTIFFMake])
        );
        imageexplorer_set_string_value(
            metadata,
            @"model",
            imageexplorer_first_value(tiff, @[(NSString *)kCGImagePropertyTIFFModel])
        );
        imageexplorer_set_string_value(
            metadata,
            @"lens",
            imageexplorer_first_value(exif, @[(NSString *)kCGImagePropertyExifLensModel])
        );
        if (metadata[@"lens"] == nil) {
            imageexplorer_set_string_value(
                metadata,
                @"lens",
                imageexplorer_first_value(
                    exifAux,
                    @[(NSString *)kCGImagePropertyExifAuxLensModel]
                )
            );
        }
        if (metadata[@"lens"] == nil) {
            imageexplorer_set_string_value(
                metadata,
                @"lens",
                imageexplorer_first_value(exif, @[(NSString *)kCGImagePropertyExifLensMake])
            );
        }
        imageexplorer_set_string_value(
            metadata,
            @"iso",
            imageexplorer_first_value(
                exif,
                @[
                    (NSString *)kCGImagePropertyExifISOSpeedRatings,
                    (NSString *)kCGImagePropertyExifISOSpeed
                ]
            )
        );
        imageexplorer_set_string_value(
            metadata,
            @"shutterSpeed",
            imageexplorer_first_value(exif, @[(NSString *)kCGImagePropertyExifExposureTime])
        );
        imageexplorer_set_string_value(
            metadata,
            @"aperture",
            imageexplorer_first_value(exif, @[(NSString *)kCGImagePropertyExifFNumber])
        );
        imageexplorer_set_string_value(
            metadata,
            @"focalLength",
            imageexplorer_first_value(exif, @[(NSString *)kCGImagePropertyExifFocalLength])
        );
        imageexplorer_set_string_value(
            metadata,
            @"capturedAt",
            imageexplorer_first_value(exif, @[(NSString *)kCGImagePropertyExifDateTimeOriginal])
        );

        NSDictionary *gps = properties[(NSString *)kCGImagePropertyGPSDictionary];
        NSNumber *latitude = gps[(NSString *)kCGImagePropertyGPSLatitude];
        NSNumber *longitude = gps[(NSString *)kCGImagePropertyGPSLongitude];
        if ([latitude isKindOfClass:[NSNumber class]] && [longitude isKindOfClass:[NSNumber class]]) {
            double lat = latitude.doubleValue;
            double lon = longitude.doubleValue;
            if ([gps[(NSString *)kCGImagePropertyGPSLatitudeRef] isEqual:@"S"]) lat = -lat;
            if ([gps[(NSString *)kCGImagePropertyGPSLongitudeRef] isEqual:@"W"]) lon = -lon;
            if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
                metadata[@"latitude"] = @(lat);
                metadata[@"longitude"] = @(lon);
            }
        }

        if (metadata.count == 0) {
            return NULL;
        }

        NSError *error = nil;
        NSData *json = [NSJSONSerialization dataWithJSONObject:metadata options:0 error:&error];
        if (json == nil || error != nil || json.length == 0) {
            return NULL;
        }

        uint8_t *result = malloc(json.length);
        if (result == NULL) {
            return NULL;
        }

        [json getBytes:result length:json.length];
        *length = json.length;
        return result;
    }
}

// Read orientation-corrected image dimensions directly via ImageIO without
// spawning `/usr/bin/sips`.
int imageexplorer_image_dimensions(const char *path, uint32_t *outWidth, uint32_t *outHeight) {
    if (path == NULL || outWidth == NULL || outHeight == NULL) {
        return 0;
    }

    @autoreleasepool {
        NSString *filePath = [NSString stringWithUTF8String:path];
        if (filePath == nil) {
            return 0;
        }

        NSURL *fileURL = [NSURL fileURLWithPath:filePath];
        CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)fileURL, NULL);
        if (source == NULL) {
            return 0;
        }

        NSDictionary *properties = CFBridgingRelease(
            CGImageSourceCopyPropertiesAtIndex(source, 0, NULL)
        );
        CFRelease(source);
        if (properties == nil) {
            return 0;
        }

        NSNumber *widthNumber = properties[(NSString *)kCGImagePropertyPixelWidth];
        NSNumber *heightNumber = properties[(NSString *)kCGImagePropertyPixelHeight];
        if (![widthNumber isKindOfClass:NSNumber.class] || ![heightNumber isKindOfClass:NSNumber.class]) {
            return 0;
        }

        uint32_t width = widthNumber.unsignedIntValue;
        uint32_t height = heightNumber.unsignedIntValue;
        if (width == 0 || height == 0) {
            return 0;
        }

        NSNumber *orientationNumber = properties[(NSString *)kCGImagePropertyOrientation];
        NSInteger orientation = [orientationNumber isKindOfClass:NSNumber.class]
            ? orientationNumber.integerValue
            : 1;
        if (orientation >= 5 && orientation <= 8) {
            uint32_t tmp = width;
            width = height;
            height = tmp;
        }

        *outWidth = width;
        *outHeight = height;
        return 1;
    }
}

static char *imageexplorer_copy_utf8(NSString *value) {
    if (value == nil) {
        return NULL;
    }
    const char *utf8 = value.UTF8String;
    if (utf8 == NULL) {
        return NULL;
    }
    return strdup(utf8);
}

void imageexplorer_free_c_string(char *value) {
    free(value);
}

// Read macOS Finder tags via NSURLTagNamesKey and return a UTF-8 JSON array.
uint8_t *imageexplorer_get_file_tags(const char *path, size_t *length) {
    if (path == NULL || length == NULL) {
        return NULL;
    }
    *length = 0;

    @autoreleasepool {
        NSString *filePath = [NSString stringWithUTF8String:path];
        if (filePath == nil) {
            return NULL;
        }
        NSURL *fileURL = [NSURL fileURLWithPath:filePath];
        id tagValue = nil;
        if (![fileURL getResourceValue:&tagValue forKey:NSURLTagNamesKey error:NULL]) {
            return NULL;
        }
        if (![tagValue isKindOfClass:NSArray.class]) {
            return NULL;
        }
        NSArray *tags = (NSArray *)tagValue;
        if (tags.count == 0) {
            return NULL;
        }
        NSData *json = [NSJSONSerialization dataWithJSONObject:tags options:0 error:NULL];
        if (json == nil || json.length == 0) {
            return NULL;
        }
        uint8_t *result = malloc(json.length);
        if (result == NULL) {
            return NULL;
        }
        [json getBytes:result length:json.length];
        *length = json.length;
        return result;
    }
}

// Write macOS Finder tags via NSURLTagNamesKey from a UTF-8 JSON string array.
int imageexplorer_set_file_tags(const char *path, const char *tagsJson, char **outError) {
    if (outError != NULL) {
        *outError = NULL;
    }
    if (path == NULL || tagsJson == NULL) {
        return 0;
    }

    @autoreleasepool {
        NSString *filePath = [NSString stringWithUTF8String:path];
        NSData *jsonData = [NSData dataWithBytes:tagsJson length:strlen(tagsJson)];
        if (filePath == nil || jsonData == nil) {
            return 0;
        }
        NSError *parseError = nil;
        id parsed = [NSJSONSerialization JSONObjectWithData:jsonData options:0 error:&parseError];
        if (![parsed isKindOfClass:NSArray.class]) {
            if (outError != NULL && parseError != nil) {
                *outError = imageexplorer_copy_utf8(parseError.localizedDescription);
            }
            return 0;
        }
        NSMutableArray<NSString *> *cleanTags = [NSMutableArray array];
        for (id item in (NSArray *)parsed) {
            if ([item isKindOfClass:NSString.class]) {
                NSString *trimmed = [(NSString *)item stringByTrimmingCharactersInSet:
                    [NSCharacterSet whitespaceAndNewlineCharacterSet]];
                if (trimmed.length > 0 && ![cleanTags containsObject:trimmed]) {
                    [cleanTags addObject:trimmed];
                }
            }
        }

        NSURL *fileURL = [NSURL fileURLWithPath:filePath];
        NSError *writeError = nil;
        BOOL ok = [fileURL setResourceValue:cleanTags forKey:NSURLTagNamesKey error:&writeError];
        if (!ok && outError != NULL && writeError != nil) {
            *outError = imageexplorer_copy_utf8(writeError.localizedDescription);
        }
        return ok ? 1 : 0;
    }
}

// Safely unmount and eject an external or network volume via NSWorkspace.
int imageexplorer_eject_volume(const char *path, char **outError) {
    if (outError != NULL) {
        *outError = NULL;
    }
    if (path == NULL) {
        return 0;
    }

    @autoreleasepool {
        NSString *volumePath = [NSString stringWithUTF8String:path];
        if (volumePath == nil) {
            return 0;
        }
        NSURL *volumeURL = [NSURL fileURLWithPath:volumePath];
        NSError *error = nil;
        BOOL ok = [[NSWorkspace sharedWorkspace] unmountAndEjectDeviceAtURL:volumeURL error:&error];
        if (!ok && outError != NULL && error != nil) {
            *outError = imageexplorer_copy_utf8(error.localizedDescription);
        }
        return ok ? 1 : 0;
    }
}

// Resolve a macOS Finder alias file in-process without spawning mdls/osascript.
// Sets *outIsAlias to 1 when the URL is a native Finder alias file (even if its
// target is missing), and returns a newly allocated UTF-8 target path if resolved.
char *imageexplorer_resolve_alias(const char *path, int *outIsAlias) {
    if (outIsAlias != NULL) {
        *outIsAlias = 0;
    }
    if (path == NULL) {
        return NULL;
    }

    @autoreleasepool {
        NSString *filePath = [NSString stringWithUTF8String:path];
        if (filePath == nil) {
            return NULL;
        }
        NSURL *fileURL = [NSURL fileURLWithPath:filePath];
        NSNumber *isAlias = nil;
        NSNumber *isSymlink = nil;
        [fileURL getResourceValue:&isAlias forKey:NSURLIsAliasFileKey error:NULL];
        [fileURL getResourceValue:&isSymlink forKey:NSURLIsSymbolicLinkKey error:NULL];
        BOOL nativeAlias = isAlias.boolValue && !isSymlink.boolValue;
        if (outIsAlias != NULL) {
            *outIsAlias = nativeAlias ? 1 : 0;
        }
        if (!nativeAlias) {
            return NULL;
        }

        NSURLBookmarkResolutionOptions options =
            NSURLBookmarkResolutionWithoutUI | NSURLBookmarkResolutionWithoutMounting;
        NSURL *resolved = [NSURL URLByResolvingAliasFileAtURL:fileURL options:options error:NULL];
        if (resolved == nil || resolved.path.length == 0) {
            return NULL;
        }
        return imageexplorer_copy_utf8(resolved.path);
    }
}

static BOOL imageexplorer_landmark_centroid(
    VNFaceLandmarkRegion2D *region,
    CGRect faceBox,
    double *outX,
    double *outY
) {
    if (region == nil || region.pointCount == 0 || region.normalizedPoints == NULL) {
        return NO;
    }
    const CGPoint *pts = region.normalizedPoints;
    double sumX = 0.0;
    double sumY = 0.0;
    NSUInteger count = region.pointCount;
    for (NSUInteger i = 0; i < count; i++) {
        sumX += pts[i].x;
        sumY += pts[i].y;
    }
    double avgX = sumX / (double)count;
    double avgY = sumY / (double)count;
    *outX = faceBox.origin.x + avgX * faceBox.size.width;
    *outY = 1.0 - (faceBox.origin.y + avgY * faceBox.size.height);
    return YES;
}

static uint8_t *imageexplorer_detect_faces_on_cgimage(CGImageRef cgImage, size_t *outLength) {
    if (cgImage == NULL || outLength == NULL) {
        return NULL;
    }
    *outLength = 0;

    VNDetectFaceLandmarksRequest *request = [[VNDetectFaceLandmarksRequest alloc] init];
    VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:cgImage
                                                                            options:@{}];
    NSError *error = nil;
    if (![handler performRequests:@[request] error:&error] || error != nil) {
        return NULL;
    }

    NSArray<VNFaceObservation *> *observations = request.results;
    NSMutableArray<NSDictionary *> *faces = [NSMutableArray array];
    for (VNFaceObservation *obs in observations) {
        CGRect box = obs.boundingBox;
        double x = box.origin.x;
        double y = 1.0 - (box.origin.y + box.size.height);
        double w = box.size.width;
        double h = box.size.height;

        double leftX = 0.0, leftY = 0.0;
        double rightX = 0.0, rightY = 0.0;
        BOOL hasLeft = imageexplorer_landmark_centroid(obs.landmarks.leftPupil, box, &leftX, &leftY) ||
                       imageexplorer_landmark_centroid(obs.landmarks.leftEye, box, &leftX, &leftY);
        BOOL hasRight = imageexplorer_landmark_centroid(obs.landmarks.rightPupil, box, &rightX, &rightY) ||
                        imageexplorer_landmark_centroid(obs.landmarks.rightEye, box, &rightX, &rightY);

        double eyeX = x + w * 0.5;
        double eyeY = y + h * 0.36;
        if (hasLeft && hasRight) {
            eyeX = (leftX + rightX) * 0.5;
            eyeY = (leftY + rightY) * 0.5;
        } else if (hasLeft) {
            eyeX = leftX;
            eyeY = leftY;
        } else if (hasRight) {
            eyeX = rightX;
            eyeY = rightY;
        }

        NSMutableDictionary *entry = [NSMutableDictionary dictionaryWithDictionary:@{
            @"x": @(x),
            @"y": @(y),
            @"width": @(w),
            @"height": @(h),
            @"eyeX": @(eyeX),
            @"eyeY": @(eyeY),
            @"_area": @(w * h),
        }];
        if (hasLeft) {
            entry[@"leftEye"] = @[@(leftX), @(leftY)];
        }
        if (hasRight) {
            entry[@"rightEye"] = @[@(rightX), @(rightY)];
        }
        [faces addObject:entry];
    }

    [faces sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
        double areaA = [a[@"_area"] doubleValue];
        double areaB = [b[@"_area"] doubleValue];
        if (areaA > areaB) return NSOrderedAscending;
        if (areaA < areaB) return NSOrderedDescending;
        return NSOrderedSame;
    }];

    NSMutableArray<NSDictionary *> *cleanFaces = [NSMutableArray arrayWithCapacity:faces.count];
    for (NSDictionary *item in faces) {
        NSMutableDictionary *copy = [item mutableCopy];
        [copy removeObjectForKey:@"_area"];
        [cleanFaces addObject:copy];
    }

    NSData *json = [NSJSONSerialization dataWithJSONObject:cleanFaces options:0 error:NULL];
    if (json == nil || json.length == 0) {
        return NULL;
    }
    uint8_t *result = malloc(json.length);
    if (result == NULL) {
        return NULL;
    }
    [json getBytes:result length:json.length];
    *outLength = json.length;
    return result;
}

static CGImageRef imageexplorer_create_upright_cgimage_for_vision(CGImageSourceRef source) {
    if (source == NULL) {
        return NULL;
    }
    NSDictionary *options = @{
        (id)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
        (id)kCGImageSourceCreateThumbnailWithTransform: @YES,
        (id)kCGImageSourceThumbnailMaxPixelSize: @1280,
    };
    CGImageRef thumb = CGImageSourceCreateThumbnailAtIndex(source, 0, (__bridge CFDictionaryRef)options);
    if (thumb != NULL) {
        return thumb;
    }
    return CGImageSourceCreateImageAtIndex(source, 0, NULL);
}

// Detect faces and eye landmarks via macOS Vision.framework from in-memory JPEG/image bytes.
uint8_t *imageexplorer_detect_faces_from_bytes(
    const uint8_t *bytes,
    size_t length,
    size_t *outLength
) {
    if (bytes == NULL || length == 0 || outLength == NULL) {
        return NULL;
    }
    *outLength = 0;

    @autoreleasepool {
        CFDataRef data = CFDataCreateWithBytesNoCopy(
            kCFAllocatorDefault,
            bytes,
            (CFIndex)length,
            kCFAllocatorNull
        );
        if (data == NULL) {
            return NULL;
        }
        CGImageSourceRef source = CGImageSourceCreateWithData(data, NULL);
        CFRelease(data);
        if (source == NULL) {
            return NULL;
        }
        CGImageRef image = imageexplorer_create_upright_cgimage_for_vision(source);
        CFRelease(source);
        if (image == NULL) {
            return NULL;
        }
        uint8_t *result = imageexplorer_detect_faces_on_cgimage(image, outLength);
        CGImageRelease(image);
        return result;
    }
}

// Detect faces and eye landmarks via macOS Vision.framework directly from a file path.
uint8_t *imageexplorer_detect_faces(const char *path, size_t *outLength) {
    if (path == NULL || outLength == NULL) {
        return NULL;
    }
    *outLength = 0;

    @autoreleasepool {
        NSString *filePath = [NSString stringWithUTF8String:path];
        if (filePath == nil) {
            return NULL;
        }
        NSURL *fileURL = [NSURL fileURLWithPath:filePath];
        CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)fileURL, NULL);
        if (source == NULL) {
            return NULL;
        }
        CGImageRef image = imageexplorer_create_upright_cgimage_for_vision(source);
        CFRelease(source);
        if (image == NULL) {
            return NULL;
        }
        uint8_t *result = imageexplorer_detect_faces_on_cgimage(image, outLength);
        CGImageRelease(image);
        return result;
    }
}

// Export an image (including macOS-supported RAW files) to JPEG, PNG, or HEIC
// with optional long-edge resize, compression quality, and GPS stripping.
int imageexplorer_export_image(
    const char *srcPath,
    const char *dstPath,
    const char *format,
    uint32_t maxEdge,
    double quality,
    int stripGps,
    char **outError
) {
    if (outError != NULL) {
        *outError = NULL;
    }
    if (srcPath == NULL || dstPath == NULL || format == NULL) {
        return 0;
    }

    @autoreleasepool {
        NSString *srcStr = [NSString stringWithUTF8String:srcPath];
        NSString *dstStr = [NSString stringWithUTF8String:dstPath];
        NSString *fmtStr = [[NSString stringWithUTF8String:format] lowercaseString];
        if (srcStr == nil || dstStr == nil || fmtStr == nil) {
            return 0;
        }

        CFStringRef uti = CFSTR("public.jpeg");
        BOOL isLossy = YES;
        if ([fmtStr isEqualToString:@"png"]) {
            uti = CFSTR("public.png");
            isLossy = NO;
        } else if ([fmtStr isEqualToString:@"heic"]) {
            uti = CFSTR("public.heic");
            isLossy = YES;
        }

        NSURL *srcURL = [NSURL fileURLWithPath:srcStr];
        CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)srcURL, NULL);
        if (source == NULL) {
            if (outError != NULL) {
                *outError = imageexplorer_copy_utf8(@"Unable to open source image");
            }
            return 0;
        }

        NSDictionary *srcProps = CFBridgingRelease(
            CGImageSourceCopyPropertiesAtIndex(source, 0, NULL)
        );
        NSNumber *pixelWidth = srcProps[(id)kCGImagePropertyPixelWidth];
        NSNumber *pixelHeight = srcProps[(id)kCGImagePropertyPixelHeight];
        NSUInteger origMax = MAX(pixelWidth.unsignedIntegerValue, pixelHeight.unsignedIntegerValue);

        CGImageRef image = NULL;
        uint32_t targetMax = 0;
        if (maxEdge > 0 && (origMax == 0 || origMax > maxEdge)) {
            targetMax = maxEdge;
        } else if (origMax > 0) {
            targetMax = (uint32_t)origMax;
        }

        if (targetMax > 0) {
            NSDictionary *thumbOpts = @{
                (id)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
                (id)kCGImageSourceCreateThumbnailWithTransform: @YES,
                (id)kCGImageSourceThumbnailMaxPixelSize: @(targetMax),
            };
            image = CGImageSourceCreateThumbnailAtIndex(source, 0, (__bridge CFDictionaryRef)thumbOpts);
        }
        if (image == NULL) {
            image = CGImageSourceCreateImageAtIndex(source, 0, NULL);
        }
        CFRelease(source);

        if (image == NULL) {
            if (outError != NULL) {
                *outError = imageexplorer_copy_utf8(@"Failed to decode image for export");
            }
            return 0;
        }

        NSMutableDictionary *destProps = [NSMutableDictionary dictionary];
        if (srcProps != nil) {
            id exif = srcProps[(id)kCGImagePropertyExifDictionary];
            if (exif != nil) {
                destProps[(id)kCGImagePropertyExifDictionary] = exif;
            }
            id tiff = srcProps[(id)kCGImagePropertyTIFFDictionary];
            if ([tiff isKindOfClass:NSDictionary.class]) {
                NSMutableDictionary *cleanTiff = [(NSDictionary *)tiff mutableCopy];
                cleanTiff[(id)kCGImagePropertyTIFFOrientation] = @1;
                destProps[(id)kCGImagePropertyTIFFDictionary] = cleanTiff;
            }
            if (!stripGps) {
                id gps = srcProps[(id)kCGImagePropertyGPSDictionary];
                if (gps != nil) {
                    destProps[(id)kCGImagePropertyGPSDictionary] = gps;
                }
            }
        }
        destProps[(id)kCGImagePropertyOrientation] = @1;
        if (isLossy) {
            double clamped = quality;
            if (clamped < 0.1) clamped = 0.1;
            if (clamped > 1.0) clamped = 1.0;
            destProps[(id)kCGImageDestinationLossyCompressionQuality] = @(clamped);
        }

        NSURL *dstURL = [NSURL fileURLWithPath:dstStr];
        CGImageDestinationRef dest = CGImageDestinationCreateWithURL(
            (__bridge CFURLRef)dstURL,
            uti,
            1,
            NULL
        );
        if (dest == NULL) {
            CGImageRelease(image);
            if (outError != NULL) {
                *outError = imageexplorer_copy_utf8(@"Unable to create image destination");
            }
            return 0;
        }

        CGImageDestinationAddImage(dest, image, (__bridge CFDictionaryRef)destProps);
        BOOL finalized = CGImageDestinationFinalize(dest);
        CFRelease(dest);
        CGImageRelease(image);

        if (!finalized && outError != NULL) {
            *outError = imageexplorer_copy_utf8(@"Failed to finalize exported image");
        }
        return finalized ? 1 : 0;
    }
}

// Rotate a raster image file 90 degrees clockwise or counter-clockwise in-process
// via CoreGraphics + ImageIO and replace the file atomically.
int imageexplorer_rotate_image(const char *path, int clockwise, char **outError) {
    if (outError != NULL) {
        *outError = NULL;
    }
    if (path == NULL) {
        return 0;
    }

    @autoreleasepool {
        NSString *filePath = [NSString stringWithUTF8String:path];
        if (filePath == nil) {
            return 0;
        }
        NSURL *fileURL = [NSURL fileURLWithPath:filePath];
        CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)fileURL, NULL);
        if (source == NULL) {
            if (outError != NULL) {
                *outError = imageexplorer_copy_utf8(@"Unable to open image for rotation");
            }
            return 0;
        }

        CFStringRef sourceType = CGImageSourceGetType(source);
        CFStringRef outputUTI = sourceType != NULL ? CFRetain(sourceType) : CFRetain(CFSTR("public.jpeg"));
        NSDictionary *srcProps = CFBridgingRelease(
            CGImageSourceCopyPropertiesAtIndex(source, 0, NULL)
        );
        NSNumber *pixelWidth = srcProps[(id)kCGImagePropertyPixelWidth];
        NSNumber *pixelHeight = srcProps[(id)kCGImagePropertyPixelHeight];
        NSUInteger maxDim = MAX(pixelWidth.unsignedIntegerValue, pixelHeight.unsignedIntegerValue);

        CGImageRef upright = NULL;
        if (maxDim > 0) {
            NSDictionary *opts = @{
                (id)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
                (id)kCGImageSourceCreateThumbnailWithTransform: @YES,
                (id)kCGImageSourceThumbnailMaxPixelSize: @(maxDim),
            };
            upright = CGImageSourceCreateThumbnailAtIndex(source, 0, (__bridge CFDictionaryRef)opts);
        }
        if (upright == NULL) {
            upright = CGImageSourceCreateImageAtIndex(source, 0, NULL);
        }
        CFRelease(source);

        if (upright == NULL) {
            CFRelease(outputUTI);
            if (outError != NULL) {
                *outError = imageexplorer_copy_utf8(@"Failed to decode image");
            }
            return 0;
        }

        size_t origW = CGImageGetWidth(upright);
        size_t origH = CGImageGetHeight(upright);
        size_t newW = origH;
        size_t newH = origW;

        CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
        CGContextRef ctx = CGBitmapContextCreate(
            NULL,
            newW,
            newH,
            8,
            0,
            colorSpace,
            (CGBitmapInfo)kCGImageAlphaPremultipliedLast
        );
        CGColorSpaceRelease(colorSpace);
        if (ctx == NULL) {
            CGImageRelease(upright);
            CFRelease(outputUTI);
            if (outError != NULL) {
                *outError = imageexplorer_copy_utf8(@"Failed to allocate graphics context");
            }
            return 0;
        }

        CGContextTranslateCTM(ctx, (CGFloat)newW * 0.5, (CGFloat)newH * 0.5);
        // CoreGraphics Y-axis points up: clockwise 90 deg is -pi/2, CCW is +pi/2.
        CGContextRotateCTM(ctx, clockwise ? -(CGFloat)M_PI_2 : (CGFloat)M_PI_2);
        CGContextDrawImage(
            ctx,
            CGRectMake(-(CGFloat)origW * 0.5, -(CGFloat)origH * 0.5, (CGFloat)origW, (CGFloat)origH),
            upright
        );
        CGImageRef rotated = CGBitmapContextCreateImage(ctx);
        CGContextRelease(ctx);
        CGImageRelease(upright);

        if (rotated == NULL) {
            CFRelease(outputUTI);
            if (outError != NULL) {
                *outError = imageexplorer_copy_utf8(@"Failed to render rotated image");
            }
            return 0;
        }

        NSString *tempPath = [NSString stringWithFormat:@"%@.rotate-%@.tmp",
                              filePath, [[NSUUID UUID] UUIDString]];
        NSURL *tempURL = [NSURL fileURLWithPath:tempPath];
        CGImageDestinationRef dest = CGImageDestinationCreateWithURL(
            (__bridge CFURLRef)tempURL,
            outputUTI,
            1,
            NULL
        );
        CFRelease(outputUTI);
        if (dest == NULL) {
            CGImageRelease(rotated);
            if (outError != NULL) {
                *outError = imageexplorer_copy_utf8(@"Format does not support in-place image rotation");
            }
            return 0;
        }

        NSMutableDictionary *destProps = srcProps != nil
            ? [srcProps mutableCopy]
            : [NSMutableDictionary dictionary];
        destProps[(id)kCGImagePropertyOrientation] = @1;
        id tiff = destProps[(id)kCGImagePropertyTIFFDictionary];
        if ([tiff isKindOfClass:NSDictionary.class]) {
            NSMutableDictionary *cleanTiff = [(NSDictionary *)tiff mutableCopy];
            cleanTiff[(id)kCGImagePropertyTIFFOrientation] = @1;
            destProps[(id)kCGImagePropertyTIFFDictionary] = cleanTiff;
        }
        destProps[(id)kCGImageDestinationLossyCompressionQuality] = @0.94;

        CGImageDestinationAddImage(dest, rotated, (__bridge CFDictionaryRef)destProps);
        BOOL finalized = CGImageDestinationFinalize(dest);
        CFRelease(dest);
        CGImageRelease(rotated);

        if (!finalized) {
            [[NSFileManager defaultManager] removeItemAtURL:tempURL error:NULL];
            if (outError != NULL) {
                *outError = imageexplorer_copy_utf8(@"Failed to save rotated image");
            }
            return 0;
        }

        NSError *replaceError = nil;
        NSURL *replacedURL = nil;
        BOOL replaced = [[NSFileManager defaultManager] replaceItemAtURL:fileURL
                                                           withItemAtURL:tempURL
                                                          backupItemName:nil
                                                                 options:0
                                                        resultingItemURL:&replacedURL
                                                                   error:&replaceError];
        if (!replaced) {
            [[NSFileManager defaultManager] removeItemAtURL:tempURL error:NULL];
            if (outError != NULL && replaceError != nil) {
                *outError = imageexplorer_copy_utf8(replaceError.localizedDescription);
            }
            return 0;
        }
        return 1;
    }
}

// Present the native macOS NSSharingServicePicker (AirDrop, Mail, Messages, etc.)
// anchored near the current cursor inside the active application window.
int imageexplorer_share_files(const char *pathsJson, char **outError) {
    if (outError != NULL) {
        *outError = NULL;
    }
    if (pathsJson == NULL) {
        return 0;
    }

    @autoreleasepool {
        NSData *jsonData = [NSData dataWithBytes:pathsJson length:strlen(pathsJson)];
        id parsed = [NSJSONSerialization JSONObjectWithData:jsonData options:0 error:NULL];
        if (![parsed isKindOfClass:NSArray.class]) {
            if (outError != NULL) {
                *outError = imageexplorer_copy_utf8(@"Invalid paths payload");
            }
            return 0;
        }

        NSMutableArray<NSURL *> *urls = [NSMutableArray array];
        for (id item in (NSArray *)parsed) {
            if ([item isKindOfClass:NSString.class] && [(NSString *)item length] > 0) {
                [urls addObject:[NSURL fileURLWithPath:(NSString *)item]];
            }
        }
        if (urls.count == 0) {
            return 0;
        }

        dispatch_async(dispatch_get_main_queue(), ^{
            NSWindow *window = [NSApp keyWindow];
            if (window == nil) {
                for (NSWindow *candidate in [NSApp windows]) {
                    if (candidate.isVisible && candidate.contentView != nil) {
                        window = candidate;
                        break;
                    }
                }
            }
            NSView *contentView = window.contentView;
            if (window == nil || contentView == nil) {
                return;
            }
            NSPoint screenPt = [NSEvent mouseLocation];
            NSPoint windowPt = [window convertPointFromScreen:screenPt];
            NSPoint viewPt = [contentView convertPoint:windowPt fromView:nil];
            NSRect bounds = contentView.bounds;
            if (!NSPointInRect(viewPt, bounds)) {
                viewPt = NSMakePoint(NSMidX(bounds), NSMidY(bounds));
            }
            NSRect anchorRect = NSMakeRect(viewPt.x, viewPt.y, 1.0, 1.0);
            NSSharingServicePicker *picker = [[NSSharingServicePicker alloc] initWithItems:urls];
            [picker showRelativeToRect:anchorRect ofView:contentView preferredEdge:NSRectEdgeMinY];
        });

        return 1;
    }
}

static uint8_t *imageexplorer_recognize_text_on_cgimage(
    CGImageRef cgImage,
    int accurate,
    size_t *outLength
) {
    if (cgImage == NULL || outLength == NULL) {
        return NULL;
    }
    *outLength = 0;

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunguarded-availability-new"
    Class requestClass = NSClassFromString(@"VNRecognizeTextRequest");
    if (requestClass == Nil) {
        return NULL;
    }

    VNRecognizeTextRequest *request = [[requestClass alloc] init];
    if (request == nil) {
        return NULL;
    }
    request.recognitionLevel = accurate
        ? VNRequestTextRecognitionLevelAccurate
        : VNRequestTextRecognitionLevelFast;
    request.usesLanguageCorrection = YES;
    if ([request respondsToSelector:@selector(setRecognitionLanguages:)]) {
        request.recognitionLanguages = @[@"zh-Hans", @"zh-Hant", @"en-US"];
    }
    if ([request respondsToSelector:@selector(setMinimumTextHeight:)]) {
        request.minimumTextHeight = 0.012f;
    }

    VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:cgImage
                                                                            options:@{}];
    NSError *error = nil;
    if (![handler performRequests:@[request] error:&error] || error != nil) {
        return NULL;
    }

    NSArray<VNRecognizedTextObservation *> *observations = request.results;
    NSMutableArray<NSDictionary *> *lines = [NSMutableArray array];
    for (VNRecognizedTextObservation *obs in observations) {
        NSArray<VNRecognizedText *> *candidates = [obs topCandidates:1];
        VNRecognizedText *best = candidates.firstObject;
        if (best == nil) {
            continue;
        }
        NSString *trimmed = [best.string stringByTrimmingCharactersInSet:
            [NSCharacterSet whitespaceAndNewlineCharacterSet]];
        if (trimmed.length == 0) {
            continue;
        }
        CGRect box = obs.boundingBox;
        double x = box.origin.x;
        double y = 1.0 - (box.origin.y + box.size.height);
        double w = box.size.width;
        double h = box.size.height;
        [lines addObject:@{
            @"text": trimmed,
            @"confidence": @((double)best.confidence),
            @"x": @(x),
            @"y": @(y),
            @"width": @(w),
            @"height": @(h),
        }];
    }
#pragma clang diagnostic pop

    // Sort top-to-bottom, left-to-right within the same visual text row.
    [lines sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
        double yA = [a[@"y"] doubleValue];
        double yB = [b[@"y"] doubleValue];
        double hAvg = ([a[@"height"] doubleValue] + [b[@"height"] doubleValue]) * 0.35;
        double tol = MAX(0.012, hAvg);
        if (fabs(yA - yB) <= tol) {
            double xA = [a[@"x"] doubleValue];
            double xB = [b[@"x"] doubleValue];
            if (xA < xB) return NSOrderedAscending;
            if (xA > xB) return NSOrderedDescending;
            return NSOrderedSame;
        }
        return yA < yB ? NSOrderedAscending : NSOrderedDescending;
    }];

    NSData *json = [NSJSONSerialization dataWithJSONObject:lines options:0 error:NULL];
    if (json == nil || json.length == 0) {
        return NULL;
    }
    uint8_t *result = malloc(json.length);
    if (result == NULL) {
        return NULL;
    }
    [json getBytes:result length:json.length];
    *outLength = json.length;
    return result;
}

static CGImageRef imageexplorer_create_upright_cgimage_for_ocr(
    CGImageSourceRef source,
    uint32_t maxPixelSize
) {
    if (source == NULL) {
        return NULL;
    }
    uint32_t target = maxPixelSize > 0 ? maxPixelSize : 2048;
    NSDictionary *options = @{
        (id)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
        (id)kCGImageSourceCreateThumbnailWithTransform: @YES,
        (id)kCGImageSourceThumbnailMaxPixelSize: @(target),
    };
    CGImageRef thumb = CGImageSourceCreateThumbnailAtIndex(source, 0, (__bridge CFDictionaryRef)options);
    if (thumb != NULL) {
        return thumb;
    }
    return CGImageSourceCreateImageAtIndex(source, 0, NULL);
}

// Recognize Chinese/English text via macOS Vision.framework from in-memory JPEG/image bytes.
uint8_t *imageexplorer_recognize_text_from_bytes(
    const uint8_t *bytes,
    size_t length,
    int accurate,
    size_t *outLength
) {
    if (bytes == NULL || length == 0 || outLength == NULL) {
        return NULL;
    }
    *outLength = 0;

    @autoreleasepool {
        CFDataRef data = CFDataCreateWithBytesNoCopy(
            kCFAllocatorDefault,
            bytes,
            (CFIndex)length,
            kCFAllocatorNull
        );
        if (data == NULL) {
            return NULL;
        }
        CGImageSourceRef source = CGImageSourceCreateWithData(data, NULL);
        CFRelease(data);
        if (source == NULL) {
            return NULL;
        }
        CGImageRef image = imageexplorer_create_upright_cgimage_for_ocr(source, accurate ? 2048 : 1280);
        CFRelease(source);
        if (image == NULL) {
            return NULL;
        }
        uint8_t *result = imageexplorer_recognize_text_on_cgimage(image, accurate, outLength);
        CGImageRelease(image);
        return result;
    }
}

// Recognize Chinese/English text via macOS Vision.framework directly from a file path.
uint8_t *imageexplorer_recognize_text(
    const char *path,
    int accurate,
    size_t *outLength
) {
    if (path == NULL || outLength == NULL) {
        return NULL;
    }
    *outLength = 0;

    @autoreleasepool {
        NSString *filePath = [NSString stringWithUTF8String:path];
        if (filePath == nil) {
            return NULL;
        }
        NSURL *fileURL = [NSURL fileURLWithPath:filePath];
        CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)fileURL, NULL);
        if (source == NULL) {
            return NULL;
        }
        CGImageRef image = imageexplorer_create_upright_cgimage_for_ocr(source, accurate ? 2048 : 1280);
        CFRelease(source);
        if (image == NULL) {
            return NULL;
        }
        uint8_t *result = imageexplorer_recognize_text_on_cgimage(image, accurate, outLength);
        CGImageRelease(image);
        return result;
    }
}

static NSString *imageexplorer_encode_cgimage_jpeg_base64(CGImageRef image, uint32_t maxEdge) {
    if (image == NULL) {
        return nil;
    }
    size_t w = CGImageGetWidth(image);
    size_t h = CGImageGetHeight(image);
    if (w == 0 || h == 0) {
        return nil;
    }
    double scale = 1.0;
    size_t maxDim = MAX(w, h);
    if (maxEdge > 0 && maxDim > maxEdge) {
        scale = (double)maxEdge / (double)maxDim;
    }
    size_t dstW = MAX((size_t)1, (size_t)llround((double)w * scale));
    size_t dstH = MAX((size_t)1, (size_t)llround((double)h * scale));

    CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
    CGContextRef ctx = CGBitmapContextCreate(
        NULL, dstW, dstH, 8, 0, cs, (CGBitmapInfo)kCGImageAlphaPremultipliedLast
    );
    CGColorSpaceRelease(cs);
    if (ctx == NULL) {
        return nil;
    }
    CGContextSetInterpolationQuality(ctx, kCGInterpolationHigh);
    CGContextDrawImage(ctx, CGRectMake(0, 0, (CGFloat)dstW, (CGFloat)dstH), image);
    CGImageRef scaled = CGBitmapContextCreateImage(ctx);
    CGContextRelease(ctx);
    if (scaled == NULL) {
        return nil;
    }

    CFMutableDataRef data = CFDataCreateMutable(kCFAllocatorDefault, 0);
    CGImageDestinationRef dest = data != NULL
        ? CGImageDestinationCreateWithData(data, CFSTR("public.jpeg"), 1, NULL)
        : NULL;
    NSString *b64 = nil;
    if (dest != NULL) {
        NSDictionary *opts = @{(id)kCGImageDestinationLossyCompressionQuality: @0.78};
        CGImageDestinationAddImage(dest, scaled, (__bridge CFDictionaryRef)opts);
        if (CGImageDestinationFinalize(dest)) {
            NSData *nsData = (__bridge NSData *)data;
            b64 = [nsData base64EncodedStringWithOptions:0];
        }
        CFRelease(dest);
    }
    if (data != NULL) {
        CFRelease(data);
    }
    CGImageRelease(scaled);
    return b64;
}

static uint8_t *imageexplorer_extract_face_embeddings_on_cgimage(
    CGImageRef cgImage,
    size_t *outLength
) {
    if (cgImage == NULL || outLength == NULL) {
        return NULL;
    }
    *outLength = 0;

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunguarded-availability-new"
    Class fpClass = NSClassFromString(@"VNGenerateImageFeaturePrintRequest");
    if (fpClass == Nil) {
        return NULL;
    }

    VNDetectFaceRectanglesRequest *faceReq = [[VNDetectFaceRectanglesRequest alloc] init];
    VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:cgImage
                                                                            options:@{}];
    NSError *err = nil;
    if (![handler performRequests:@[faceReq] error:&err] || err != nil) {
        return NULL;
    }

    NSArray<VNFaceObservation *> *observations = faceReq.results;
    if (observations.count == 0) {
        return NULL;
    }

    size_t imgW = CGImageGetWidth(cgImage);
    size_t imgH = CGImageGetHeight(cgImage);
    if (imgW == 0 || imgH == 0) {
        return NULL;
    }

    NSMutableArray<NSDictionary *> *results = [NSMutableArray array];
    for (VNFaceObservation *obs in observations) {
        CGRect box = obs.boundingBox;
        // Skip tiny background passersby faces that introduce clustering noise
        if (box.size.width < 0.032 && box.size.height < 0.032) {
            continue;
        }
        double normX = box.origin.x;
        double normY = 1.0 - (box.origin.y + box.size.height);
        double normW = box.size.width;
        double normH = box.size.height;

        // Pad crop by ~20% to capture facial contour & hair context for Vision feature prints
        double padX = normW * 0.20;
        double padY = normH * 0.22;
        double cropX = MAX(0.0, normX - padX) * (double)imgW;
        double cropY = MAX(0.0, normY - padY) * (double)imgH;
        double cropRight = MIN(1.0, normX + normW + padX) * (double)imgW;
        double cropBottom = MIN(1.0, normY + normH + padY) * (double)imgH;
        double cropW = cropRight - cropX;
        double cropH = cropBottom - cropY;
        if (cropW < 16.0 || cropH < 16.0) {
            continue;
        }

        CGImageRef faceCrop = CGImageCreateWithImageInRect(
            cgImage,
            CGRectMake(cropX, cropY, cropW, cropH)
        );
        if (faceCrop == NULL) {
            continue;
        }

        VNRequest *fpReq = [[fpClass alloc] init];
        VNImageRequestHandler *cropHandler = [[VNImageRequestHandler alloc] initWithCGImage:faceCrop
                                                                                    options:@{}];
        NSError *fpErr = nil;
        NSString *embeddingB64 = nil;
        if ([cropHandler performRequests:@[fpReq] error:&fpErr] && fpErr == nil) {
            VNFeaturePrintObservation *fpObs = (VNFeaturePrintObservation *)fpReq.results.firstObject;
            if (fpObs != nil && fpObs.data != nil && fpObs.elementCount > 0) {
                NSUInteger count = fpObs.elementCount;
                NSMutableData *floatBytes = [NSMutableData dataWithLength:count * sizeof(float)];
                float *dst = (float *)floatBytes.mutableBytes;
                BOOL valid = NO;
                if (fpObs.elementType == VNElementTypeFloat && fpObs.data.length >= count * sizeof(float)) {
                    memcpy(dst, fpObs.data.bytes, count * sizeof(float));
                    valid = YES;
                } else if (fpObs.elementType == VNElementTypeDouble && fpObs.data.length >= count * sizeof(double)) {
                    const double *src = (const double *)fpObs.data.bytes;
                    for (NSUInteger i = 0; i < count; i++) {
                        dst[i] = (float)src[i];
                    }
                    valid = YES;
                }
                if (valid) {
                    // L2-normalize to unit length so dot product == cosine similarity
                    double normSq = 0.0;
                    for (NSUInteger i = 0; i < count; i++) {
                        normSq += (double)dst[i] * (double)dst[i];
                    }
                    if (normSq > 1e-12) {
                        float invNorm = (float)(1.0 / sqrt(normSq));
                        for (NSUInteger i = 0; i < count; i++) {
                            dst[i] *= invNorm;
                        }
                        embeddingB64 = [floatBytes base64EncodedStringWithOptions:0];
                    }
                }
            }
        }

        NSString *avatarB64 = embeddingB64 != nil
            ? imageexplorer_encode_cgimage_jpeg_base64(faceCrop, 112)
            : nil;
        CGImageRelease(faceCrop);

        if (embeddingB64 != nil) {
            NSMutableDictionary *entry = [NSMutableDictionary dictionaryWithDictionary:@{
                @"x": @(normX),
                @"y": @(normY),
                @"width": @(normW),
                @"height": @(normH),
                @"area": @(normW * normH),
                @"embeddingB64": embeddingB64,
            }];
            if (avatarB64 != nil) {
                entry[@"avatarB64"] = avatarB64;
            }
            [results addObject:entry];
        }
    }
#pragma clang diagnostic pop

    if (results.count == 0) {
        return NULL;
    }

    NSData *json = [NSJSONSerialization dataWithJSONObject:results options:0 error:NULL];
    if (json == nil || json.length == 0) {
        return NULL;
    }
    uint8_t *output = malloc(json.length);
    if (output == NULL) {
        return NULL;
    }
    [json getBytes:output length:json.length];
    *outLength = json.length;
    return output;
}

// Detect faces and extract L2-normalized Vision feature-print embeddings from in-memory bytes.
uint8_t *imageexplorer_extract_face_embeddings_from_bytes(
    const uint8_t *bytes,
    size_t length,
    size_t *outLength
) {
    if (bytes == NULL || length == 0 || outLength == NULL) {
        return NULL;
    }
    *outLength = 0;

    @autoreleasepool {
        CFDataRef data = CFDataCreateWithBytesNoCopy(
            kCFAllocatorDefault, bytes, (CFIndex)length, kCFAllocatorNull
        );
        if (data == NULL) {
            return NULL;
        }
        CGImageSourceRef source = CGImageSourceCreateWithData(data, NULL);
        CFRelease(data);
        if (source == NULL) {
            return NULL;
        }
        CGImageRef image = imageexplorer_create_upright_cgimage_for_vision(source);
        CFRelease(source);
        if (image == NULL) {
            return NULL;
        }
        uint8_t *result = imageexplorer_extract_face_embeddings_on_cgimage(image, outLength);
        CGImageRelease(image);
        return result;
    }
}

// Detect faces and extract L2-normalized Vision feature-print embeddings directly from a file path.
uint8_t *imageexplorer_extract_face_embeddings(const char *path, size_t *outLength) {
    if (path == NULL || outLength == NULL) {
        return NULL;
    }
    *outLength = 0;

    @autoreleasepool {
        NSString *filePath = [NSString stringWithUTF8String:path];
        if (filePath == nil) {
            return NULL;
        }
        NSURL *fileURL = [NSURL fileURLWithPath:filePath];
        CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)fileURL, NULL);
        if (source == NULL) {
            return NULL;
        }
        CGImageRef image = imageexplorer_create_upright_cgimage_for_vision(source);
        CFRelease(source);
        if (image == NULL) {
            return NULL;
        }
        uint8_t *result = imageexplorer_extract_face_embeddings_on_cgimage(image, outLength);
        CGImageRelease(image);
        return result;
    }
}

static long long imageexplorer_gcd_ll(long long a, long long b) {
    if (a < 0) a = -a;
    if (b < 0) b = -b;
    while (b != 0) {
        long long t = a % b;
        a = b;
        b = t;
    }
    return a > 0 ? a : 1;
}

// ImageIO's CGImageMetadataSetValueMatchingImageProperty serializes XMP rational
// tags (FNumber, ExposureTime, FocalLength) accurately when given "num/den" strings;
// passing NSNumber directly truncates decimals like 1.4 or 0.004 to integers.
static NSString *imageexplorer_double_to_exif_rational(double val, BOOL preferUnitFraction) {
    if (!isfinite(val) || val <= 0.0) {
        return nil;
    }
    if (preferUnitFraction && val < 1.0) {
        double recip = 1.0 / val;
        long long rounded = llround(recip);
        if (rounded >= 1 && rounded <= 100000 && fabs(recip - (double)rounded) < 0.02 * (double)rounded) {
            return [NSString stringWithFormat:@"1/%lld", rounded];
        }
        long long den = 100000;
        long long num = llround(val * (double)den);
        if (num < 1) num = 1;
        long long g = imageexplorer_gcd_ll(num, den);
        return [NSString stringWithFormat:@"%lld/%lld", num / g, den / g];
    }
    long long den = 100;
    long long num = llround(val * (double)den);
    if (num < 1) num = 1;
    long long g = imageexplorer_gcd_ll(num, den);
    return [NSString stringWithFormat:@"%lld/%lld", num / g, den / g];
}

// Losslessly merge EXIF, TIFF, ExifAux, and GPS metadata into a JPEG/HEIC/PNG/TIFF
// using ImageIO `CGImageDestinationCopyImageSource` (zero pixel re-compression),
// replacing the file atomically.
int imageexplorer_write_image_metadata(
    const char *path,
    const char *patchJson,
    int overwriteExisting,
    char **outError
) {
    if (outError != NULL) {
        *outError = NULL;
    }
    if (path == NULL || patchJson == NULL) {
        return 0;
    }

    @autoreleasepool {
        NSString *filePath = [NSString stringWithUTF8String:path];
        NSData *jsonData = [NSData dataWithBytes:patchJson length:strlen(patchJson)];
        if (filePath == nil || jsonData == nil) {
            return 0;
        }

        NSError *parseErr = nil;
        id parsed = [NSJSONSerialization JSONObjectWithData:jsonData options:0 error:&parseErr];
        if (![parsed isKindOfClass:NSDictionary.class]) {
            if (outError != NULL && parseErr != nil) {
                *outError = imageexplorer_copy_utf8(parseErr.localizedDescription);
            }
            return 0;
        }
        NSDictionary *patch = (NSDictionary *)parsed;

        NSURL *srcURL = [NSURL fileURLWithPath:filePath];
        CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)srcURL, NULL);
        if (source == NULL) {
            if (outError != NULL) {
                *outError = imageexplorer_copy_utf8(@"Unable to open image for EXIF update");
            }
            return 0;
        }

        CFStringRef sourceType = CGImageSourceGetType(source);
        if (sourceType == NULL) {
            CFRelease(source);
            if (outError != NULL) {
                *outError = imageexplorer_copy_utf8(@"Unknown image format");
            }
            return 0;
        }

        NSDictionary *existingProps = CFBridgingRelease(
            CGImageSourceCopyPropertiesAtIndex(source, 0, NULL)
        );
        NSDictionary *existingExif = [existingProps[(id)kCGImagePropertyExifDictionary] isKindOfClass:NSDictionary.class]
            ? existingProps[(id)kCGImagePropertyExifDictionary]
            : @{};
        NSDictionary *existingExifAux = [existingProps[(id)kCGImagePropertyExifAuxDictionary] isKindOfClass:NSDictionary.class]
            ? existingProps[(id)kCGImagePropertyExifAuxDictionary]
            : @{};
        NSDictionary *existingTiff = [existingProps[(id)kCGImagePropertyTIFFDictionary] isKindOfClass:NSDictionary.class]
            ? existingProps[(id)kCGImagePropertyTIFFDictionary]
            : @{};
        NSDictionary *existingGps = [existingProps[(id)kCGImagePropertyGPSDictionary] isKindOfClass:NSDictionary.class]
            ? existingProps[(id)kCGImagePropertyGPSDictionary]
            : @{};

        NSMutableDictionary *nextExif = [existingExif mutableCopy];
        NSMutableDictionary *nextExifAux = [existingExifAux mutableCopy];
        NSMutableDictionary *nextTiff = [existingTiff mutableCopy];
        NSMutableDictionary *nextGps = [existingGps mutableCopy];

        CGImageMetadataRef existingMeta = CGImageSourceCopyMetadataAtIndex(source, 0, NULL);
        CGMutableImageMetadataRef mutableMeta = existingMeta != NULL
            ? CGImageMetadataCreateMutableCopy(existingMeta)
            : CGImageMetadataCreateMutable();
        if (existingMeta != NULL) {
            CFRelease(existingMeta);
        }
        if (mutableMeta == NULL) {
            mutableMeta = CGImageMetadataCreateMutable();
        }
        BOOL changed = NO;

        BOOL (^shouldWrite)(NSDictionary *, id) = ^BOOL(NSDictionary *dict, id key) {
            if (overwriteExisting) return YES;
            id cur = dict[key];
            if (cur == nil || cur == [NSNull null]) return YES;
            if ([cur isKindOfClass:NSString.class] && [(NSString *)cur length] == 0) return YES;
            if ([cur isKindOfClass:NSArray.class] && [(NSArray *)cur count] == 0) return YES;
            return NO;
        };

        void (^setMetaProp)(CFStringRef, CFStringRef, id) = ^(CFStringRef dictName, CFStringRef propName, id val) {
            if (mutableMeta != NULL && val != nil) {
                CGImageMetadataSetValueMatchingImageProperty(
                    mutableMeta,
                    dictName,
                    propName,
                    (__bridge CFTypeRef)val
                );
            }
        };

        NSString *make = [patch[@"make"] isKindOfClass:NSString.class] ? patch[@"make"] : nil;
        if (make.length > 0 && shouldWrite(existingTiff, (id)kCGImagePropertyTIFFMake)) {
            nextTiff[(id)kCGImagePropertyTIFFMake] = make;
            setMetaProp(kCGImagePropertyTIFFDictionary, kCGImagePropertyTIFFMake, make);
            changed = YES;
        }

        NSString *model = [patch[@"model"] isKindOfClass:NSString.class] ? patch[@"model"] : nil;
        if (model.length > 0 && shouldWrite(existingTiff, (id)kCGImagePropertyTIFFModel)) {
            nextTiff[(id)kCGImagePropertyTIFFModel] = model;
            setMetaProp(kCGImagePropertyTIFFDictionary, kCGImagePropertyTIFFModel, model);
            changed = YES;
        }

        NSString *lens = [patch[@"lens"] isKindOfClass:NSString.class] ? patch[@"lens"] : nil;
        if (lens.length > 0 &&
            (overwriteExisting ||
             (shouldWrite(existingExif, (id)kCGImagePropertyExifLensModel) &&
              shouldWrite(existingExifAux, (id)kCGImagePropertyExifAuxLensModel)))) {
            nextExif[(id)kCGImagePropertyExifLensModel] = lens;
            nextExifAux[(id)kCGImagePropertyExifAuxLensModel] = lens;
            setMetaProp(kCGImagePropertyExifDictionary, kCGImagePropertyExifLensModel, lens);
            setMetaProp(kCGImagePropertyExifAuxDictionary, kCGImagePropertyExifAuxLensModel, lens);
            changed = YES;
        }

        NSNumber *iso = [patch[@"iso"] isKindOfClass:NSNumber.class] ? patch[@"iso"] : nil;
        if (iso != nil && iso.doubleValue > 0 &&
            shouldWrite(existingExif, (id)kCGImagePropertyExifISOSpeedRatings)) {
            NSArray *isoArr = @[@(iso.integerValue)];
            nextExif[(id)kCGImagePropertyExifISOSpeedRatings] = isoArr;
            setMetaProp(kCGImagePropertyExifDictionary, kCGImagePropertyExifISOSpeedRatings, isoArr);
            changed = YES;
        }

        NSNumber *aperture = [patch[@"aperture"] isKindOfClass:NSNumber.class] ? patch[@"aperture"] : nil;
        if (aperture != nil && aperture.doubleValue > 0 &&
            shouldWrite(existingExif, (id)kCGImagePropertyExifFNumber)) {
            nextExif[(id)kCGImagePropertyExifFNumber] = aperture;
            NSString *apRat = imageexplorer_double_to_exif_rational(aperture.doubleValue, NO);
            setMetaProp(kCGImagePropertyExifDictionary, kCGImagePropertyExifFNumber, apRat ?: (id)aperture);
            changed = YES;
        }

        NSNumber *shutter = [patch[@"shutterSpeed"] isKindOfClass:NSNumber.class] ? patch[@"shutterSpeed"] : nil;
        if (shutter != nil && shutter.doubleValue > 0 &&
            shouldWrite(existingExif, (id)kCGImagePropertyExifExposureTime)) {
            nextExif[(id)kCGImagePropertyExifExposureTime] = shutter;
            NSString *shRat = imageexplorer_double_to_exif_rational(shutter.doubleValue, YES);
            setMetaProp(kCGImagePropertyExifDictionary, kCGImagePropertyExifExposureTime, shRat ?: (id)shutter);
            changed = YES;
        }

        NSNumber *focal = [patch[@"focalLength"] isKindOfClass:NSNumber.class] ? patch[@"focalLength"] : nil;
        if (focal != nil && focal.doubleValue > 0 &&
            shouldWrite(existingExif, (id)kCGImagePropertyExifFocalLength)) {
            nextExif[(id)kCGImagePropertyExifFocalLength] = focal;
            NSString *flRat = imageexplorer_double_to_exif_rational(focal.doubleValue, NO);
            setMetaProp(kCGImagePropertyExifDictionary, kCGImagePropertyExifFocalLength, flRat ?: (id)focal);
            changed = YES;
        }

        NSString *capturedAt = [patch[@"capturedAt"] isKindOfClass:NSString.class] ? patch[@"capturedAt"] : nil;
        if (capturedAt.length > 0 && shouldWrite(existingExif, (id)kCGImagePropertyExifDateTimeOriginal)) {
            nextExif[(id)kCGImagePropertyExifDateTimeOriginal] = capturedAt;
            nextExif[(id)kCGImagePropertyExifDateTimeDigitized] = capturedAt;
            nextTiff[(id)kCGImagePropertyTIFFDateTime] = capturedAt;
            setMetaProp(kCGImagePropertyExifDictionary, kCGImagePropertyExifDateTimeOriginal, capturedAt);
            setMetaProp(kCGImagePropertyExifDictionary, kCGImagePropertyExifDateTimeDigitized, capturedAt);
            setMetaProp(kCGImagePropertyTIFFDictionary, kCGImagePropertyTIFFDateTime, capturedAt);
            changed = YES;
        }

        NSNumber *lat = [patch[@"latitude"] isKindOfClass:NSNumber.class] ? patch[@"latitude"] : nil;
        NSNumber *lon = [patch[@"longitude"] isKindOfClass:NSNumber.class] ? patch[@"longitude"] : nil;
        if (lat != nil && lon != nil &&
            (overwriteExisting ||
             shouldWrite(existingGps, (id)kCGImagePropertyGPSLatitude) ||
             shouldWrite(existingGps, (id)kCGImagePropertyGPSLongitude))) {
            double latVal = lat.doubleValue;
            double lonVal = lon.doubleValue;
            if (latVal >= -90.0 && latVal <= 90.0 && lonVal >= -180.0 && lonVal <= 180.0) {
                NSNumber *absLat = @(fabs(latVal));
                NSString *latRef = latVal < 0.0 ? @"S" : @"N";
                NSNumber *absLon = @(fabs(lonVal));
                NSString *lonRef = lonVal < 0.0 ? @"W" : @"E";
                nextGps[(id)kCGImagePropertyGPSLatitude] = absLat;
                nextGps[(id)kCGImagePropertyGPSLatitudeRef] = latRef;
                nextGps[(id)kCGImagePropertyGPSLongitude] = absLon;
                nextGps[(id)kCGImagePropertyGPSLongitudeRef] = lonRef;
                nextGps[(id)kCGImagePropertyGPSVersion] = @"2.3.0.0";
                setMetaProp(kCGImagePropertyGPSDictionary, kCGImagePropertyGPSLatitude, absLat);
                setMetaProp(kCGImagePropertyGPSDictionary, kCGImagePropertyGPSLatitudeRef, latRef);
                setMetaProp(kCGImagePropertyGPSDictionary, kCGImagePropertyGPSLongitude, absLon);
                setMetaProp(kCGImagePropertyGPSDictionary, kCGImagePropertyGPSLongitudeRef, lonRef);
                setMetaProp(kCGImagePropertyGPSDictionary, kCGImagePropertyGPSVersion, @"2.3.0.0");
                changed = YES;
            }
        }

        if (!changed) {
            if (mutableMeta != NULL) {
                CFRelease(mutableMeta);
            }
            CFRelease(source);
            return 2; // No-op (nothing missing / nothing to write)
        }

        NSMutableDictionary *mergeOptions = [NSMutableDictionary dictionary];
        mergeOptions[(id)kCGImageDestinationMergeMetadata] = @YES;
        if (mutableMeta != NULL) {
            mergeOptions[(id)kCGImageDestinationMetadata] = (__bridge id)mutableMeta;
        }

        NSString *tempPath = [NSString stringWithFormat:@"%@.exif-%@.tmp",
                              filePath, [[NSUUID UUID] UUIDString]];
        NSURL *tempURL = [NSURL fileURLWithPath:tempPath];
        CGImageDestinationRef dest = CGImageDestinationCreateWithURL(
            (__bridge CFURLRef)tempURL,
            sourceType,
            1,
            NULL
        );
        if (dest == NULL) {
            if (mutableMeta != NULL) {
                CFRelease(mutableMeta);
            }
            CFRelease(source);
            if (outError != NULL) {
                *outError = imageexplorer_copy_utf8(@"Image format does not support metadata writing");
            }
            return 0;
        }

        CFErrorRef copyError = NULL;
        BOOL ok = CGImageDestinationCopyImageSource(
            dest,
            source,
            (__bridge CFDictionaryRef)mergeOptions,
            &copyError
        );
        if (mutableMeta != NULL) {
            CFRelease(mutableMeta);
            mutableMeta = NULL;
        }
        if (!ok) {
            // Fallback for formats where lossless CopyImageSource is unsupported (e.g., certain PNGs)
            if (copyError != NULL) {
                CFRelease(copyError);
                copyError = NULL;
            }
            CFRelease(dest);
            [[NSFileManager defaultManager] removeItemAtURL:tempURL error:NULL];

            CGImageRef img = CGImageSourceCreateImageAtIndex(source, 0, NULL);
            if (img != NULL) {
                CGImageDestinationRef fallbackDest = CGImageDestinationCreateWithURL(
                    (__bridge CFURLRef)tempURL,
                    sourceType,
                    1,
                    NULL
                );
                if (fallbackDest != NULL) {
                    NSMutableDictionary *fullProps = existingProps != nil
                        ? [existingProps mutableCopy]
                        : [NSMutableDictionary dictionary];
                    if (nextExif.count > 0) fullProps[(id)kCGImagePropertyExifDictionary] = nextExif;
                    if (nextExifAux.count > 0) fullProps[(id)kCGImagePropertyExifAuxDictionary] = nextExifAux;
                    if (nextTiff.count > 0) fullProps[(id)kCGImagePropertyTIFFDictionary] = nextTiff;
                    if (nextGps.count > 0) fullProps[(id)kCGImagePropertyGPSDictionary] = nextGps;
                    fullProps[(id)kCGImageDestinationLossyCompressionQuality] = @0.96;
                    CGImageDestinationAddImage(fallbackDest, img, (__bridge CFDictionaryRef)fullProps);
                    ok = CGImageDestinationFinalize(fallbackDest);
                    CFRelease(fallbackDest);
                }
                CGImageRelease(img);
            }
        } else {
            CFRelease(dest);
        }
        CFRelease(source);

        if (!ok) {
            [[NSFileManager defaultManager] removeItemAtURL:tempURL error:NULL];
            if (outError != NULL) {
                if (copyError != NULL) {
                    NSError *nsErr = CFBridgingRelease(copyError);
                    *outError = imageexplorer_copy_utf8(nsErr.localizedDescription);
                } else {
                    *outError = imageexplorer_copy_utf8(@"Failed to write EXIF metadata");
                }
            }
            return 0;
        }
        if (copyError != NULL) {
            CFRelease(copyError);
        }

        NSError *replaceError = nil;
        NSURL *resultingURL = nil;
        BOOL replaced = [[NSFileManager defaultManager] replaceItemAtURL:srcURL
                                                           withItemAtURL:tempURL
                                                          backupItemName:nil
                                                                 options:0
                                                        resultingItemURL:&resultingURL
                                                                   error:&replaceError];
        if (!replaced) {
            [[NSFileManager defaultManager] removeItemAtURL:tempURL error:NULL];
            if (outError != NULL && replaceError != nil) {
                *outError = imageexplorer_copy_utf8(replaceError.localizedDescription);
            }
            return 0;
        }
        return 1;
    }
}
