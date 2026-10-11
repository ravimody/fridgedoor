#!/usr/bin/env swift
// Draws the Fridgedoor app icon (light and dark, 1024×1024) with CoreGraphics:
// a rounded fridge door with two handles, a note pinned by a teal magnet.
// Colors follow "Linen & Teal" (FridgedoorKit/Support/Palette.swift, DESIGN.md).
//
// Usage (from ios/):  swift scripts/make-icon.swift
// Writes Fridgedoor/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon{,-Dark}.png.
// Both PNGs are opaque: App Store icons may not have an alpha channel.

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct Theme {
    var backgroundTop: UInt32
    var backgroundBottom: UInt32
    var door: UInt32
    var outline: UInt32
    var note: UInt32
    var noteLine: UInt32
    var magnet: UInt32
    var magnetShine: UInt32
    var shadowAlpha: CGFloat

    static let light = Theme(backgroundTop: 0xF6F2EA, backgroundBottom: 0xEBE3D7, door: 0xFBF8F2, outline: 0x404A5A,
                             note: 0xF3EBDB, noteLine: 0xD2C7B4, magnet: 0x4E9B92, magnetShine: 0x7DBDB4, shadowAlpha: 0.10)
    static let dark = Theme(backgroundTop: 0x353C48, backgroundBottom: 0x242930, door: 0x2E3540, outline: 0xEAE5DC,
                            note: 0x414A58, noteLine: 0x5A6474, magnet: 0x8FCDC4, magnetShine: 0xC5E9E2, shadowAlpha: 0.30)
}

func color(_ hex: UInt32, alpha: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
}

func draw(_ theme: Theme, size: Int = 1024) -> CGImage {
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    // noneSkipLast: no alpha channel in the output.
    let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    // Work in a top-left, 1024-point coordinate space.
    let scale = CGFloat(size) / 1024
    context.translateBy(x: 0, y: CGFloat(size))
    context.scaleBy(x: scale, y: -scale)

    // Background: a soft diagonal gradient.
    let gradient = CGGradient(colorsSpace: space, colors: [color(theme.backgroundTop), color(theme.backgroundBottom)] as CFArray, locations: [0, 1])!
    context.drawLinearGradient(gradient, start: CGPoint(x: 0, y: 0), end: CGPoint(x: 1024, y: 1024), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])

    // The door, with a soft drop shadow. (Shadow offsets ignore the flipped CTM:
    // negative heights fall downward.)
    let door = CGRect(x: 287, y: 148, width: 450, height: 728)
    let doorPath = CGPath(roundedRect: door, cornerWidth: 78, cornerHeight: 78, transform: nil)
    context.saveGState()
    context.setShadow(offset: CGSize(width: 0, height: -14), blur: 36, color: color(0x000000, alpha: theme.shadowAlpha))
    context.addPath(doorPath)
    context.setFillColor(color(theme.door))
    context.fillPath()
    context.restoreGState()

    context.addPath(doorPath)
    context.setStrokeColor(color(theme.outline))
    context.setLineWidth(30)
    context.strokePath()

    // Freezer seam.
    context.setLineCap(.round)
    context.move(to: CGPoint(x: door.minX, y: 368))
    context.addLine(to: CGPoint(x: door.maxX, y: 368))
    context.strokePath()

    // Handles, on the opening side.
    context.setFillColor(color(theme.outline))
    for handle in [CGRect(x: 338, y: 226, width: 30, height: 92), CGRect(x: 338, y: 420, width: 30, height: 156)] {
        context.addPath(CGPath(roundedRect: handle, cornerWidth: 15, cornerHeight: 15, transform: nil))
        context.fillPath()
    }

    // The pinned note, slightly askew.
    context.saveGState()
    context.translateBy(x: 560, y: 636)
    context.rotate(by: -0.07)
    let note = CGRect(x: -110, y: -104, width: 220, height: 220)
    context.saveGState()
    context.setShadow(offset: CGSize(width: 0, height: -8), blur: 18, color: color(0x000000, alpha: theme.shadowAlpha * 1.4))
    context.addPath(CGPath(roundedRect: note, cornerWidth: 14, cornerHeight: 14, transform: nil))
    context.setFillColor(color(theme.note))
    context.fillPath()
    context.restoreGState()
    context.setStrokeColor(color(theme.noteLine))
    context.setLineWidth(12)
    for (index, y) in [-12.0, 34, 80].enumerated() {
        context.move(to: CGPoint(x: note.minX + 34, y: y))
        context.addLine(to: CGPoint(x: note.maxX - (index == 2 ? 86 : 34), y: y))
        context.strokePath()
    }

    // The magnet holding it up.
    let magnet = CGRect(x: -38, y: -142, width: 76, height: 76)
    context.saveGState()
    context.setShadow(offset: CGSize(width: 0, height: -6), blur: 10, color: color(0x000000, alpha: theme.shadowAlpha * 1.6))
    context.setFillColor(color(theme.magnet))
    context.fillEllipse(in: magnet)
    context.restoreGState()
    context.setFillColor(color(theme.magnetShine))
    context.fillEllipse(in: CGRect(x: magnet.minX + 17, y: magnet.minY + 14, width: 22, height: 22))
    context.restoreGState()

    return context.makeImage()!
}

func write(_ image: CGImage, to url: URL) {
    let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { fatalError("Couldn't write \(url.path)") }
    print("Wrote \(url.path)")
}

// `swift file.swift` runs in an interpreter where #filePath isn't the real path,
// so find the icon set from the working directory (ios/ or the repo root).
let relative = "Fridgedoor/Resources/Assets.xcassets/AppIcon.appiconset"
let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
guard let iconSet = [cwd.appending(path: relative), cwd.appending(path: "ios/\(relative)")]
    .first(where: { FileManager.default.fileExists(atPath: $0.path) }) else {
    fatalError("Run from ios/ or the repository root: \(relative) not found")
}
write(draw(.light), to: iconSet.appending(path: "AppIcon.png"))
write(draw(.dark), to: iconSet.appending(path: "AppIcon-Dark.png"))
