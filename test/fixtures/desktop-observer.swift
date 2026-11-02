import AppKit
import CoreGraphics
import Foundation
let duration=Double(CommandLine.arguments.dropFirst().first ?? "0") ?? 0
let start=Date();var result:[[String:Any]]=[]
repeat {
 let app=NSWorkspace.shared.frontmostApplication
 let point=CGEvent(source:nil)?.location ?? .zero
 result.append(["time":Date().timeIntervalSince(start),"pid":app?.processIdentifier ?? -1,"bundleId":app?.bundleIdentifier ?? "","x":point.x,"y":point.y])
 if duration > 0 { Thread.sleep(forTimeInterval:0.02) }
} while Date().timeIntervalSince(start)<duration
print(String(data:try JSONSerialization.data(withJSONObject:result),encoding:.utf8)!)
