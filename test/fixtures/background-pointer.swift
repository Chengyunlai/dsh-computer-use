import AppKit
import Foundation
final class Receiver:NSObject {
 let path:String
 var count=0
 init(_ path:String) { self.path=path;super.init();try! "0".write(toFile:path,atomically:true,encoding:.utf8) }
 @objc func press(_ sender:NSButton) {count += 1;sender.title="Count \(count)";try! String(count).write(toFile:path,atomically:true,encoding:.utf8)}
}
try! String(ProcessInfo.processInfo.processIdentifier).write(toFile:CommandLine.arguments[1]+".pid",atomically:true,encoding:.utf8)
let app=NSApplication.shared
app.setActivationPolicy(.accessory)
let receiver=Receiver(CommandLine.arguments[1])
let window=NSWindow(contentRect:NSRect(x:200,y:200,width:260,height:180),styleMask:[.titled,.closable],backing:.buffered,defer:false)
window.title="DSH background pointer fixture"
let button=NSButton(title:"Probe",target:receiver,action:#selector(Receiver.press(_:)))
button.frame=NSRect(x:30,y:70,width:180,height:40)
window.contentView!.addSubview(button)
window.orderBack(nil)
app.run()
