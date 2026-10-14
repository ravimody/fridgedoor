#!/usr/bin/env swift
// Draws the Fridgedoor app icons with CoreGraphics, each 1024×1024 in light, dark and tinted:
// - "Big sun" (AppIcon, the default): a note with a big sun on its horizon.
// - "Rising sun" (AppIcon-RisingSun): the magnet is the sun, coming up over the day's note.
// - "Full page" (AppIcon-FullPage): the note fills the icon, pinned by a teal magnet.
// Also writes the Settings → App icon previews, the watch icon and the website icon.
//
// Usage (from ios/):  swift scripts/make-icon.swift
// Light and dark PNGs are opaque (App Store icons may not have an alpha channel). Tinted ones
// are grayscale on black; iOS colors them.

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

enum Look: CaseIterable { case light, dark, tinted }

func rgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
}

let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!

func gradient(_ colors: [CGColor], _ locations: [CGFloat]? = nil) -> CGGradient {
    CGGradient(colorsSpace: sRGB, colors: colors as CFArray, locations: locations)!
}

/// A 1024-unit canvas, y pointing down like the design mockups, drawn at `size` pixels.
struct Canvas {
    let context: CGContext
    let scale: CGFloat

    init(size: Int) {
        // noneSkipLast: no alpha channel in the output.
        context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: sRGB,
                            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        scale = CGFloat(size) / 1024
        context.translateBy(x: 0, y: CGFloat(size))
        context.scaleBy(x: scale, y: -scale)
    }

    func background(_ top: UInt32, _ bottom: UInt32) {
        context.drawLinearGradient(gradient([rgb(top), rgb(bottom)]), start: .zero, end: CGPoint(x: 0, y: 1024),
                                   options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    }

    /// Shadows are set in device space, so they ignore the flip and any rotation.
    func withShadow(dy: CGFloat, blur: CGFloat, alpha: CGFloat, _ draw: () -> Void) {
        context.saveGState()
        context.setShadow(offset: CGSize(width: 0, height: -dy * scale), blur: blur * 2 * scale, color: rgb(0, alpha))
        draw()
        context.restoreGState()
    }

    func roundedRect(_ rect: CGRect, radius: CGFloat, _ color: CGColor) {
        context.addPath(CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil))
        context.setFillColor(color)
        context.fillPath()
    }

    func bars(x: CGFloat, y: CGFloat, widths: [CGFloat], gap: CGFloat, height: CGFloat, _ color: CGColor) {
        for (index, width) in widths.enumerated() {
            roundedRect(CGRect(x: x, y: y + CGFloat(index) * gap, width: width, height: height), radius: height / 2, color)
        }
    }

    /// Five rays fanned over the top half of a circle.
    func rays(center: CGPoint, from inner: CGFloat, to outer: CGFloat, width: CGFloat, _ color: CGColor) {
        context.setStrokeColor(color)
        context.setLineWidth(width)
        context.setLineCap(.round)
        for index in 0..<5 {
            let angle = (-162 + CGFloat(index) * 36) * .pi / 180
            context.move(to: CGPoint(x: center.x + cos(angle) * inner, y: center.y + sin(angle) * inner))
            context.addLine(to: CGPoint(x: center.x + cos(angle) * outer, y: center.y + sin(angle) * outer))
        }
        context.strokePath()
    }

    /// A glossy sphere: highlight, middle and edge colors, lit from the upper left.
    func sphere(center: CGPoint, radius r: CGFloat, _ colors: [UInt32], groundShadow: Bool = false) {
        if groundShadow {
            context.setFillColor(rgb(0, 0.16))
            context.fillEllipse(in: CGRect(x: center.x + r * 0.1 - r * 0.9, y: center.y + r * 0.92 - r * 0.28, width: r * 1.8, height: r * 0.56))
        }
        context.saveGState()
        context.addEllipse(in: CGRect(x: center.x - r, y: center.y - r, width: 2 * r, height: 2 * r))
        context.clip()
        let light = CGPoint(x: center.x - 0.28 * r, y: center.y - 0.4 * r)
        context.drawRadialGradient(gradient(colors.map { rgb($0) }, [0, 0.55, 1]), startCenter: light, startRadius: 0,
                                   endCenter: light, endRadius: 1.56 * r, options: [.drawsAfterEndLocation])
        context.restoreGState()
        // The shine.
        context.saveGState()
        context.translateBy(x: center.x - 0.34 * r, y: center.y - 0.4 * r)
        context.rotate(by: -32 * .pi / 180)
        context.setFillColor(rgb(0xFFFFFF, 0.55))
        context.fillEllipse(in: CGRect(x: -0.3 * r, y: -0.18 * r, width: 0.6 * r, height: 0.36 * r))
        context.restoreGState()
    }

    /// The top half of a sun sitting on a horizon at `center.y`.
    func sun(center: CGPoint, radius r: CGFloat, top: UInt32, bottom: UInt32) {
        context.saveGState()
        context.clip(to: CGRect(x: 0, y: -1024, width: 1024, height: center.y + 1024))
        context.addEllipse(in: CGRect(x: center.x - r, y: center.y - r, width: 2 * r, height: 2 * r))
        context.clip()
        context.drawLinearGradient(gradient([rgb(top), rgb(bottom)]), start: CGPoint(x: center.x, y: center.y - r),
                                   end: CGPoint(x: center.x, y: center.y + r), options: [])
        context.restoreGState()
    }

    func glow(center: CGPoint, radius: CGFloat, _ color: UInt32, alpha: CGFloat) {
        context.drawRadialGradient(gradient([rgb(color, alpha), rgb(color, alpha * 0.75), rgb(color, 0)], [0, 0.45, 1]),
                                   startCenter: center, startRadius: 0, endCenter: center, endRadius: radius, options: [])
    }

    var image: CGImage { context.makeImage()! }
}

/// Colors shared by the designs, per look.
struct Paint {
    var note: UInt32
    var lines: UInt32
    var horizon: UInt32
    var rays: UInt32
    var sunTop: UInt32
    var sunBottom: UInt32
    var sunMagnet: [UInt32]
    var magnet: [UInt32]
    var glow: (UInt32, CGFloat)
    var shadow: CGFloat

    static func of(_ look: Look) -> Paint {
        switch look {
        case .light:
            Paint(note: 0xFFFDF9, lines: 0xE3DACD, horizon: 0xE9B8A3, rays: 0xF59A5B, sunTop: 0xFFB867, sunBottom: 0xF0614A,
                  sunMagnet: [0xFFE7B0, 0xFF9B4E, 0xDD5232], magnet: [0x9BE0D2, 0x3F9B8B, 0x236B5E], glow: (0xFFAA5E, 0.45), shadow: 0.16)
        case .dark:
            // A darker note, so the icon doesn't glare at night.
            Paint(note: 0x353D4B, lines: 0x4E586B, horizon: 0x8A5A4C, rays: 0xF59A5B, sunTop: 0xFFB867, sunBottom: 0xF0614A,
                  sunMagnet: [0xFFE7B0, 0xFF9B4E, 0xDD5232], magnet: [0xD2FFF5, 0x7FD1C0, 0x3C9483], glow: (0xFFAA5E, 0.35), shadow: 0.5)
        case .tinted:
            // Brightness carries the design: the sun brightest, the note quieter.
            Paint(note: 0x4A4A4A, lines: 0x6E6E6E, horizon: 0x9A9A9A, rays: 0xE8E8E8, sunTop: 0xFFFFFF, sunBottom: 0xD6D6D6,
                  sunMagnet: [0xFFFFFF, 0xE4E4E4, 0xA8A8A8], magnet: [0xFFFFFF, 0xBDBDBD, 0x7A7A7A], glow: (0xFFFFFF, 0.16), shadow: 0.5)
        }
    }
}

enum Design: CaseIterable {
    case bigSun, risingSun, fullPage

    /// The icon set's name in the asset catalog (`AppIcon` is the default icon).
    var iconSet: String {
        switch self {
        case .bigSun: "AppIcon"
        case .risingSun: "AppIcon-RisingSun"
        case .fullPage: "AppIcon-FullPage"
        }
    }

    var preview: String {
        switch self {
        case .risingSun: "IconPreview-RisingSun"
        case .bigSun: "IconPreview-BigSun"
        case .fullPage: "IconPreview-FullPage"
        }
    }

    func draw(_ look: Look, size: Int = 1024) -> CGImage {
        let canvas = Canvas(size: size)
        let paint = Paint.of(look)
        let context = canvas.context
        switch self {
        case .risingSun:
            switch look {
            case .light: canvas.background(0xFFE2CC, 0xF7EEE5)
            case .dark: canvas.background(0x2C2235, 0x121722)
            case .tinted: canvas.background(0x000000, 0x000000)
            }
            let sun = CGPoint(x: 512, y: 440)
            canvas.glow(center: sun, radius: 383, paint.glow.0, alpha: paint.glow.1)
            canvas.rays(center: sun, from: 220, to: 258, width: 26, rgb(paint.rays))
            canvas.sphere(center: sun, radius: 176, paint.sunMagnet)
            let note = CGRect(x: 206, y: 440, width: 612, height: 430)
            canvas.withShadow(dy: 22, blur: 28, alpha: paint.shadow) { canvas.roundedRect(note, radius: 26, rgb(paint.note)) }
            canvas.bars(x: 290, y: 560, widths: [444, 330], gap: 84, height: 28, rgb(paint.lines))

        case .bigSun, .fullPage:
            switch look {
            case .light: canvas.background(0xFFD8C0, 0xF6EDE4)
            case .dark: canvas.background(0x2E2236, 0x141824)
            case .tinted: canvas.background(0x000000, 0x000000)
            }
            let full = self == .fullPage
            let note = full ? CGRect(x: 120, y: 150, width: 784, height: 820) : CGRect(x: 196, y: 196, width: 632, height: 680)
            let horizon = note.minY + (note.height * 0.53).rounded()
            let radius: CGFloat = full ? 250 : 206
            let inset: CGFloat = 64, lineInset: CGFloat = 96
            context.saveGState()
            if full {
                context.translateBy(x: note.midX, y: note.midY)
                context.rotate(by: 2 * .pi / 180)
                context.translateBy(x: -note.midX, y: -note.midY)
            }
            canvas.withShadow(dy: 20, blur: 26, alpha: look == .light ? 0.16 : 0.45) { canvas.roundedRect(note, radius: 22, rgb(paint.note)) }
            let center = CGPoint(x: note.midX, y: horizon)
            canvas.sun(center: center, radius: radius, top: paint.sunTop, bottom: paint.sunBottom)
            canvas.rays(center: center, from: radius + (full ? 36 : 32), to: radius + (full ? 90 : 76), width: full ? 28 : 22, rgb(paint.rays))
            canvas.roundedRect(CGRect(x: note.minX + inset, y: horizon - 4, width: note.width - 2 * inset, height: 10), radius: 5, rgb(paint.horizon))
            canvas.bars(x: note.minX + lineInset, y: horizon + 90, widths: [note.width - 2 * lineInset, note.width - 2 * lineInset - 108],
                        gap: 70, height: 22, rgb(paint.lines))
            context.restoreGState()
            if full { canvas.sphere(center: CGPoint(x: 520, y: 168), radius: 70, paint.magnet, groundShadow: true) }
        }
        return canvas.image
    }
}

func write(_ image: CGImage, to url: URL) {
    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { fatalError("Couldn't write \(url.path)") }
    print("Wrote \(url.path)")
}

func writeJSON(_ object: Any, to url: URL) {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    try! data.write(to: url)
}

let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let assets = cwd.appending(path: "Fridgedoor/Resources/Assets.xcassets")
let info = ["author": "xcode", "version": 1] as [String: Any]

for design in Design.allCases {
    let set = assets.appending(path: "\(design.iconSet).appiconset")
    write(design.draw(.light), to: set.appending(path: "Icon.png"))
    write(design.draw(.dark), to: set.appending(path: "Icon-Dark.png"))
    write(design.draw(.tinted), to: set.appending(path: "Icon-Tinted.png"))
    func image(_ file: String, _ appearance: String?) -> [String: Any] {
        var entry: [String: Any] = ["filename": file, "idiom": "universal", "platform": "ios", "size": "1024x1024"]
        if let appearance { entry["appearances"] = [["appearance": "luminosity", "value": appearance]] }
        return entry
    }
    writeJSON(["images": [image("Icon.png", nil), image("Icon-Dark.png", "dark"), image("Icon-Tinted.png", "tinted")], "info": info],
              to: set.appending(path: "Contents.json"))

    // Settings → App icon shows these (an app can't load its own icon sets as images).
    let preview = assets.appending(path: "\(design.preview).imageset")
    write(design.draw(.light, size: 180), to: preview.appending(path: "Preview.png"))
    write(design.draw(.dark, size: 180), to: preview.appending(path: "Preview-Dark.png"))
    writeJSON(["images": [
        ["filename": "Preview.png", "idiom": "universal", "scale": "3x"],
        ["appearances": [["appearance": "luminosity", "value": "dark"]], "filename": "Preview-Dark.png", "idiom": "universal", "scale": "3x"],
    ], "info": info], to: preview.appending(path: "Contents.json"))
}

write(Design.bigSun.draw(.light), to: cwd.appending(path: "Watch/App/Assets.xcassets/AppIcon.appiconset/AppIcon.png"))
write(Design.bigSun.draw(.light, size: 256), to: cwd.appending(path: "../site/icon.png"))
