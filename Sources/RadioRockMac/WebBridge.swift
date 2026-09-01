import AppKit
import WebKit

/// Mostek JS <-> Swift. Odpowiednik klasy "Mostek" (@JavascriptInterface) z
/// wersji androidowej — z tego samego powodu: strona www/ ma juz gotowy,
/// sprawdzony kontrakt `window.Android`, wiec Mac udaje dokladnie to samo API
/// zamiast wprowadzac trzeci wariant. app.js nie wymaga ZADNYCH zmian.
final class WebBridge: NSObject, WKScriptMessageHandler {

    weak var audioEngine: AudioEngine?
    var wyslijDoJS: ((String) -> Void)?

    func userContentController(_ userContentController: WKUserContentController,
                                didReceive message: WKScriptMessage) {
        guard let dane = message.body as? [String: Any],
              let polecenie = dane["cmd"] as? String,
              let audioEngine = audioEngine else { return }

        switch polecenie {
        case "ustawListe":
            guard let json = dane["lista"] as? String,
                  let indeks = dane["indeks"] as? Int,
                  let daneJson = json.data(using: .utf8),
                  let tablica = try? JSONSerialization.jsonObject(with: daneJson) as? [[String: Any]] else { return }
            let kolejka = tablica.compactMap { pozycja -> StacjaKolejki? in
                guard let nazwa = pozycja["nazwa"] as? String, let url = pozycja["url"] as? String else { return nil }
                return StacjaKolejki(nazwa: nazwa, url: url)
            }
            audioEngine.ustawListe(kolejka, indeks: indeks)

        case "glosnosc":
            if let wartosc = dane["wartosc"] as? Double {
                audioEngine.ustawGlosnosc(Float(wartosc))
            }

        case "wycisz":
            audioEngine.ustawWyciszenie((dane["czy"] as? Bool) ?? false)

        case "nastepna":
            audioEngine.nastepna()

        case "poprzednia":
            audioEngine.poprzednia()

        case "przelacz":
            audioEngine.przelacz()

        case "pauza":
            audioEngine.pauza()

        case "odswiez":
            audioEngine.odswiez()

        case "restartPolaczenia":
            audioEngine.restartPolaczenia()

        case "restartAplikacji":
            restartujAplikacje()

        case "ustawUrzadzenie":
            let uid = (dane["uid"] as? String) ?? ""
            audioEngine.ustawUrzadzenieWyjsciowe(uid.isEmpty ? nil : uid)
            UserDefaults.standard.set(uid, forKey: "wyjscieAudioUID")

        default:
            break
        }
    }

    private func restartujAplikacje() {
        let sciezka = Bundle.main.bundlePath
        let konfiguracja = NSWorkspace.OpenConfiguration()
        NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: sciezka), configuration: konfiguracja) { _, _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                NSApp.terminate(nil)
            }
        }
    }

    /// Dokladnie ten sam kontrakt co window.Android w app.js (const most =
    /// window.Android). Wstrzykiwane jako WKUserScript przed zaladowaniem strony.
    static let jsShim = """
    window.Android = {
      ustawListe: function(json, indeks) {
        window.webkit.messageHandlers.mac.postMessage({cmd:'ustawListe', lista: json, indeks: indeks});
      },
      glosnosc: function(wartosc) {
        window.webkit.messageHandlers.mac.postMessage({cmd:'glosnosc', wartosc: wartosc});
      },
      wycisz: function(czy) {
        window.webkit.messageHandlers.mac.postMessage({cmd:'wycisz', czy: !!czy});
      },
      nastepna: function() {
        window.webkit.messageHandlers.mac.postMessage({cmd:'nastepna'});
      },
      poprzednia: function() {
        window.webkit.messageHandlers.mac.postMessage({cmd:'poprzednia'});
      },
      przelacz: function() {
        window.webkit.messageHandlers.mac.postMessage({cmd:'przelacz'});
      },
      pauza: function() {
        window.webkit.messageHandlers.mac.postMessage({cmd:'pauza'});
      },
      odswiez: function() {
        window.webkit.messageHandlers.mac.postMessage({cmd:'odswiez'});
      },
      restartPolaczenia: function() {
        window.webkit.messageHandlers.mac.postMessage({cmd:'restartPolaczenia'});
      },
      restartAplikacji: function() {
        window.webkit.messageHandlers.mac.postMessage({cmd:'restartAplikacji'});
      },
      ustawUrzadzenie: function(uid) {
        window.webkit.messageHandlers.mac.postMessage({cmd:'ustawUrzadzenie', uid: uid || ''});
      }
    };
    """
}
