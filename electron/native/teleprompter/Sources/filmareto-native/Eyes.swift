import CoreImage
import Foundation
import Vision

/// The eye line of the largest face in an image, 0-1 from the top left, and the face's height, as
/// "x y h". Nothing when there is no face. The same look Filmareto's Resolve chain takes before it places a zoom.
func printEyes(imagePath: String) {
    guard let image = CIImage(contentsOf: URL(fileURLWithPath: imagePath)) else { return }
    let request = VNDetectFaceLandmarksRequest()
    let handler = VNImageRequestHandler(ciImage: image, options: [:])
    guard (try? handler.perform([request])) != nil,
          let face = request.results?.max(by: {
              $0.boundingBox.width * $0.boundingBox.height < $1.boundingBox.width * $1.boundingBox.height
          })
    else { return }
    let box = face.boundingBox
    func centre(_ region: VNFaceLandmarkRegion2D?) -> CGPoint? {
        guard let region, region.pointCount > 0 else { return nil }
        let count = CGFloat(region.pointCount)
        let sum = region.normalizedPoints.reduce(CGPoint.zero) {
            CGPoint(x: $0.x + $1.x, y: $0.y + $1.y)
        }
        return CGPoint(x: box.origin.x + sum.x / count * box.width,
                       y: box.origin.y + sum.y / count * box.height)
    }
    let point: CGPoint
    if let left = centre(face.landmarks?.leftPupil) ?? centre(face.landmarks?.leftEye),
       let right = centre(face.landmarks?.rightPupil) ?? centre(face.landmarks?.rightEye) {
        point = CGPoint(x: (left.x + right.x) / 2, y: (left.y + right.y) / 2)
    } else {
        point = CGPoint(x: box.midX, y: box.origin.y + box.height * 0.62)
    }
    print(String(format: "%.5f %.5f %.5f", point.x, 1 - point.y, box.height))
}
