import Cocoa
import WebKit
import MediaPlayer

/// Pomocnicza funkcja: zamienia dowolny string Swifta na bezpieczny literal JS
/// (przez serializacje JSON, wiec cudzyslowy/backslashe/unicode nie wywroca skryptu).
func jsString(_ tekst: String) -> String {
    guard let dane = try? JSONSerialization.data(withJSONObject: [tekst]),
          let json = String(data: dane, encoding: .utf8) else { return "\"\"" }
    return String(json.dropFirst().dropLast())
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate {

    private var statusItem: NSStatusItem!
    private var okno: NSWindow!
    private var webView: WKWebView!
    private var menuWyjscia: NSMenu!

    private let webBridge = WebBridge()
    private let audioEngine = AudioEngine()
    private let serwer = ServerManager()
    private let deviceAudio = DeviceAudio()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSLog("Radio Rock: applicationDidFinishLaunching start, PID=%d", ProcessInfo.processInfo.processIdentifier)
        if let inna = innaDzialajacaInstancja() {
            NSLog("Radio Rock: inna instancja juz dziala (PID %d) - aktywuje ja i konczy ta kopie",
                  inna.processIdentifier)
            inna.activate(options: [.activateAllWindows])
            NSApp.terminate(nil)
            return
        }

        NSApp.setActivationPolicy(.accessory)

        audioEngine.wybraneUrzadzenieUID = {
            let zapisane = UserDefaults.standard.string(forKey: "wyjscieAudioUID") ?? ""
            return zapisane.isEmpty ? nil : zapisane
        }()
        audioEngine.webBridge = webBridge
        webBridge.audioEngine = audioEngine

        przygotujOkno()
        przygotujStatusItem()
        NSLog("Radio Rock: statusItem utworzony, dlugosc=%.0f, isVisible=%@",
              statusItem.length, statusItem.isVisible ? "TAK" : "NIE")
        przygotujKomendyMultimedialne()

        webBridge.wyslijDoJS = { [weak self] js in
            DispatchQueue.main.async {
                self?.webView.evaluateJavaScript(js, completionHandler: nil)
            }
        }

        deviceAudio.naZmiane = { [weak self] in
            DispatchQueue.main.async {
                self?.odswiezMenuWyjscia()
                self?.wyslijUrzadzeniaDoJS()
                self?.wyslijKorektorDoJS()
            }
        }
        deviceAudio.wystartuj()
        odswiezMenuWyjscia()

        serwer.znajdzLubUruchom { [weak self] port in
            guard let self = self else { return }
            guard let port = port else {
                NSLog("Radio Rock: nie udalo sie uruchomic ani znalezc lokalnego serwera")
                return
            }
            let adres = "http://127.0.0.1:\(port)/"
            self.audioEngine.adresBazowy = adres
            guard let url = URL(string: adres) else { return }
            self.webView.load(URLRequest(url: url))
            // Nie wysylamy tu od razu urzadzen/korektora - .load() jest asynchroniczne,
            // strona (a wiec i window.zNatywnego_*) jeszcze nie istnieje. Prawdziwa,
            // niezawodna wysylka jest w webView(_:didFinish:) nizej.
        }
    }

    // MARK: - WKNavigationDelegate

    /// Jedyny wiarygodny moment, zeby wyslac stan (lista urzadzen audio,
    /// korektor) do JS - strona i jej window.zNatywnego_* na pewno juz
    /// istnieja. Wczesniej appka probowala wyslac to od razu po webView.load(),
    /// co jest asynchroniczne i prawie zawsze trafialo w pustke - lista
    /// urzadzen wygladala na pusta, dopoki jakas PRAWDZIWA zmiana sprzetu
    /// (np. podlaczenie AirPods) nie wywolala odswiezenia przy okazji.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        odswiezMenuWyjscia()
        wyslijUrzadzeniaDoJS()
        wyslijKorektorDoJS()
    }

    private func innaDzialajacaInstancja() -> NSRunningApplication? {
        let wlasny = ProcessInfo.processInfo.processIdentifier
        return NSWorkspace.shared.runningApplications.first {
            $0.bundleIdentifier == Bundle.main.bundleIdentifier && $0.processIdentifier != wlasny
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        NSLog("Radio Rock: applicationWillTerminate, PID=%d", ProcessInfo.processInfo.processIdentifier)
        audioEngine.zatrzymaj()
        serwer.zatrzymaj()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    // MARK: - Okno

    private func przygotujOkno() {
        let config = WKWebViewConfiguration()
        let kontroler = WKUserContentController()
        kontroler.add(webBridge, name: "mac")
        kontroler.addUserScript(WKUserScript(source: WebBridge.jsShim,
                                              injectionTime: .atDocumentStart,
                                              forMainFrameOnly: true))
        config.userContentController = kontroler

        let ramka = NSRect(x: 0, y: 0, width: 1040, height: 680)
        webView = WKWebView(frame: ramka, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self

        okno = NSWindow(contentRect: ramka,
                         styleMask: [.titled, .closable, .miniaturizable, .resizable],
                         backing: .buffered,
                         defer: false)
        okno.title = "Radio Rock"
        okno.contentView = webView
        okno.isReleasedWhenClosed = false
        okno.delegate = self
        okno.center()
        okno.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        // Zamkniecie okna nie wylacza radia - dziala dalej w tle, ikona w pasku menu zostaje.
        sender.orderOut(nil)
        return false
    }

    // MARK: - Pasek menu

    private func przygotujStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        // autosaveName: AppKit zapamietuje pozycje/widocznosc ikony w pasku menu
        // (zamiast liczyc ja od zera przy kazdym starcie) - jesli system schowa
        // ja w przepelnionym pasku menu albo user ja recznie przesunie, ta sama
        // nazwa pozwala wrocic do zapamietanego stanu zamiast losowej pozycji
        // na koncu paska przy kazdym uruchomieniu appki.
        statusItem.autosaveName = "RadioRockPasekMenu"
        if let przycisk = statusItem.button {
            let obraz = NSImage(systemSymbolName: "antenna.radiowaves.left.and.right",
                                 accessibilityDescription: "Radio Rock")
            obraz?.isTemplate = true
            przycisk.image = obraz
        }

        let menu = NSMenu()
        menu.addItem(withTitle: "Pokaż Radio Rock", action: #selector(pokazOkno), keyEquivalent: "").target = self
        menu.addItem(NSMenuItem.separator())

        menuWyjscia = NSMenu()
        let pozycjaWyjscia = NSMenuItem(title: "Wyjście audio", action: nil, keyEquivalent: "")
        pozycjaWyjscia.submenu = menuWyjscia
        menu.addItem(pozycjaWyjscia)

        menu.addItem(NSMenuItem.separator())
        menu.addItem(withTitle: "Odśwież", action: #selector(odswiezRadio), keyEquivalent: "").target = self
        menu.addItem(NSMenuItem.separator())
        menu.addItem(withTitle: "Zamknij Radio Rock", action: #selector(zamknijAplikacje), keyEquivalent: "").target = self

        statusItem.menu = menu
    }

    private func odswiezMenuWyjscia() {
        guard let menuWyjscia = menuWyjscia else { return }
        menuWyjscia.removeAllItems()

        let domyslna = NSMenuItem(title: "Domyślne wyjście systemu",
                                   action: #selector(wybierzUrzadzenieZMenu(_:)),
                                   keyEquivalent: "")
        domyslna.target = self
        domyslna.representedObject = ""
        domyslna.state = (audioEngine.wybraneUrzadzenieUID ?? "").isEmpty ? .on : .off
        menuWyjscia.addItem(domyslna)
        menuWyjscia.addItem(NSMenuItem.separator())

        for urzadzenie in deviceAudio.urzadzenia {
            let pozycja = NSMenuItem(title: urzadzenie.nazwa,
                                      action: #selector(wybierzUrzadzenieZMenu(_:)),
                                      keyEquivalent: "")
            pozycja.target = self
            pozycja.representedObject = urzadzenie.uid
            pozycja.state = (audioEngine.wybraneUrzadzenieUID == urzadzenie.uid) ? .on : .off
            menuWyjscia.addItem(pozycja)
        }
    }

    @objc private func wybierzUrzadzenieZMenu(_ nadawca: NSMenuItem) {
        let uid = (nadawca.representedObject as? String) ?? ""
        ustawWyjscie(uid.isEmpty ? nil : uid)
    }

    private func ustawWyjscie(_ uid: String?) {
        audioEngine.ustawUrzadzenieWyjsciowe(uid)
        UserDefaults.standard.set(uid ?? "", forKey: "wyjscieAudioUID")
        odswiezMenuWyjscia()
        webBridge.wyslijDoJS?("window.zNatywnego_urzadzenie && window.zNatywnego_urzadzenie(\(jsString(uid ?? "")));")
    }

    private func wyslijUrzadzeniaDoJS() {
        guard let wyslij = webBridge.wyslijDoJS else { return }
        let lista = deviceAudio.urzadzenia.map { ["uid": $0.uid, "nazwa": $0.nazwa] }
        guard let dane = try? JSONSerialization.data(withJSONObject: lista),
              let json = String(data: dane, encoding: .utf8) else { return }
        let aktualny = audioEngine.wybraneUrzadzenieUID ?? ""
        wyslij("window.zNatywnego_urzadzenia && window.zNatywnego_urzadzenia(\(json), \(jsString(aktualny)));")
    }

    private func wyslijKorektorDoJS() {
        guard let wyslij = webBridge.wyslijDoJS else { return }
        let pasma = audioEngine.wzmocnieniaKorektora.map { Double($0) }
        guard let dane = try? JSONSerialization.data(withJSONObject: pasma),
              let json = String(data: dane, encoding: .utf8) else { return }
        wyslij("window.zNatywnego_korektor && window.zNatywnego_korektor(\(json));")
    }

    @objc private func pokazOkno() {
        okno.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func odswiezRadio() {
        audioEngine.odswiez(powod: "MenuPasek")
    }

    @objc private func zamknijAplikacje() {
        NSApp.terminate(nil)
    }

    // MARK: - Klawisze multimedialne / centrum sterowania

    private func przygotujKomendyMultimedialne() {
        let centrum = MPRemoteCommandCenter.shared()
        centrum.playCommand.addTarget { [weak self] _ in
            self?.audioEngine.wznow(powod: "MediaKey/CentrumSterowania"); return .success
        }
        centrum.pauseCommand.addTarget { [weak self] _ in
            self?.audioEngine.pauza(powod: "MediaKey/CentrumSterowania"); return .success
        }
        centrum.togglePlayPauseCommand.addTarget { [weak self] _ in
            self?.audioEngine.przelacz(powod: "MediaKey/CentrumSterowania"); return .success
        }
        centrum.nextTrackCommand.addTarget { [weak self] _ in
            self?.audioEngine.nastepna(powod: "MediaKey/CentrumSterowania-NASTEPNA"); return .success
        }
        centrum.previousTrackCommand.addTarget { [weak self] _ in
            self?.audioEngine.poprzednia(powod: "MediaKey/CentrumSterowania-POPRZEDNIA"); return .success
        }
    }
}
