#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#import <QuickLook/QuickLook.h>

#include <stdint.h>
#include <stdlib.h>

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
uint8_t *imageexplorer_quicklook_thumbnail(const char *path, uint32_t size, size_t *length) {
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
        // ImageIO can decode the camera source at the requested size. Quick Look
        // remains a fallback for formats that ImageIO cannot decode directly.
        CGImageRef image = imageexplorer_create_imageio_preview(fileURL, size);
        if (image == NULL) {
            image = imageexplorer_create_embedded_preview(fileURL, size);
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
