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
