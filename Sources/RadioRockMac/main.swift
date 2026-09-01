import Cocoa

let aplikacja = NSApplication.shared
let delegat = AppDelegate()
aplikacja.delegate = delegat
aplikacja.setActivationPolicy(.accessory)
aplikacja.run()
