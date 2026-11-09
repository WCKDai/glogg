// Trim transparent padding, center on a square canvas, and export PNG sizes.
// usage: swift make-icons.swift <src.png> <outDir> <size>:<name> ...
import AppKit
import CoreGraphics

let args = CommandLine.arguments
guard args.count >= 4,
      let src = NSImage(contentsOfFile: args[1]),
      let cg = src.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  fatalError("usage: make-icons <src> <outDir> size:name ...")
}
let outDir = args[2]
let w = cg.width, h = cg.height

// Read alpha to find the content bounding box.
let cs = CGColorSpaceCreateDeviceRGB()
var px = [UInt8](repeating: 0, count: w * h * 4)
let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: cs,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
var minX = w, minY = h, maxX = 0, maxY = 0
for y in 0..<h {
  for x in 0..<w where px[(y * w + x) * 4 + 3] > 12 {
    minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
  }
}
let box = CGRect(x: minX, y: h - maxY - 1, width: maxX - minX + 1, height: maxY - minY + 1)
let cropped = cg.cropping(to: box)!
print("content box \(Int(box.width))x\(Int(box.height)) of \(w)x\(h)")

for spec in args.dropFirst(3) {
  let parts = spec.split(separator: ":")
  let size = Int(parts[0])!
  let name = String(parts[1])
  let pad = size <= 32 ? 0.02 : 0.06 // tiny favicons need every pixel
  let inner = Double(size) * (1 - pad * 2)
  let scale = inner / Double(max(cropped.width, cropped.height))
  let dw = Double(cropped.width) * scale, dh = Double(cropped.height) * scale
  let out = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  out.interpolationQuality = .high
  out.draw(cropped, in: CGRect(x: (Double(size) - dw) / 2, y: (Double(size) - dh) / 2, width: dw, height: dh))
  let rep = NSBitmapImageRep(cgImage: out.makeImage()!)
  try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(outDir)/\(name)"))
  print("wrote \(name) \(size)px")
}
