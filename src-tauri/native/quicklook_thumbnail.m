#import <CoreGraphics/CoreGraphics.h>
#import <CoreImage/CoreImage.h>
#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#import <QuickLook/QuickLook.h>

#include <stdint.h>
#include <stdlib.h>

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
            NSData *jpeg = [file subdataWithRange:NSMakeRange(bestOffset, bestLength)];
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

    NSData *jpeg = [file subdataWithRange:NSMakeRange(bestOffset, bestLength)];
    CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)jpeg, NULL);
    if (source == NULL) return NULL;
    NSDictionary *options = @{
        (id)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
        (id)kCGImageSourceCreateThumbnailWithTransform: @YES,
        (id)kCGImageSourceThumbnailMaxPixelSize: @(size),
    };
    CGImageRef image = CGImageSourceCreateThumbnailAtIndex(source, 0, (__bridge CFDictionaryRef)options);
    CFRelease(source);
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
    NSString *extension = fileURL.pathExtension.lowercaseString;
    NSSet<NSString *> *rawExtensions = [NSSet setWithObjects:
        @"arw", @"cr2", @"cr3", @"nef", @"nrw", @"raf", @"orf", @"rw2",
        @"pef", @"srw", @"dcr", @"kdc", @"3fr", @"iiq", @"x3f", @"dng", nil
    ];
    if (![rawExtensions containsObject:extension]) {
        return NULL;
    }

    if (@available(macOS 12.0, *)) {
        CIRAWFilter *rawFilter = [CIRAWFilter filterWithImageURL:fileURL];
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

        CIContext *context = [CIContext contextWithOptions:@{
            kCIContextUseSoftwareRenderer: @NO,
            kCIContextHighQualityDownsample: @YES,
        }];
        if (context == nil) {
            return NULL;
        }

        return [context createCGImage:outputImage fromRect:outputImage.extent];
    }

    return NULL;
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
        // Grid thumbnails and focus analysis should use the camera-embedded JPEG
        // whenever possible. Decoding the full RAW source for every small card
        // can stall a large folder for tens of seconds. Core Image RAW decoding
        // is reserved for Quick Look; ImageIO remains the compatibility fallback.
        CGImageRef image = NULL;
        if (preferEmbedded) {
            image = imageexplorer_create_arw_full_jpeg(fileURL, size);
            // A few ARWs omit the full JPEG. Keep the high-resolution RAW
            // path for those files rather than enlarging a small thumbnail.
            if (image == NULL && size >= 2048 && [fileURL.pathExtension.lowercaseString isEqualToString:@"arw"]) {
                image = imageexplorer_create_coreimage_raw_preview(fileURL, size);
            }
        }
        if (!preferEmbedded) {
            image = imageexplorer_create_coreimage_raw_preview(fileURL, size);
        }
        if (image == NULL) {
            image = preferEmbedded
                ? imageexplorer_create_embedded_preview(fileURL, size)
                : imageexplorer_create_imageio_preview(fileURL, size);
        }
        if (image == NULL && preferEmbedded) {
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

        CGImageDestinationRef destination = CGImageDestinationCreateWithData(
            data,
            CFSTR("public.png"),
            1,
            NULL
        );
        if (destination == NULL) {
            CFRelease(data);
            CGImageRelease(image);
            return NULL;
        }

        CGImageDestinationAddImage(destination, image, NULL);
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
