import Foundation

/// Uruchamia (albo znajduje juz dzialajacy) lokalny serwer serwer.py — dokladnie
/// tak samo jak stary launcher Mac 7.2: przeszukuje porty 8790-8799 przez
/// /api/wersja, zeby nie odpalic drugiej kopii przy ponownym uruchomieniu apki.
/// Serwer startuje z REAKTO_PRZEGLADARKA=brak, bo okno przegladarki daje teraz
/// WKWebView w tej samej aplikacji, a nie zewnetrzna przegladarka.
final class ServerManager {

    private let zakresPortow = Array(8790...8799)
    private var proces: Process?

    func znajdzLubUruchom(_ zakonczenie: @escaping (Int?) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }

            if let port = self.znajdzDzialajacy() {
                DispatchQueue.main.async { zakonczenie(port) }
                return
            }

            self.uruchomProces()

            for _ in 0..<40 { // do ok. 8 s na start serwera
                Thread.sleep(forTimeInterval: 0.2)
                if let port = self.znajdzDzialajacy() {
                    DispatchQueue.main.async { zakonczenie(port) }
                    return
                }
            }
            DispatchQueue.main.async { zakonczenie(nil) }
        }
    }

    func zatrzymaj() {
        // Zamykamy tylko jesli sami go uruchomilismy w tym procesie — jesli
        // radio dzialalo juz wczesniej (druga kopia apki), zostawiamy je dzialajace.
        if let proces = proces, proces.isRunning {
            proces.terminate()
        }
    }

    private func znajdzDzialajacy() -> Int? {
        for port in zakresPortow {
            if sprawdzPort(port) { return port }
        }
        return nil
    }

    private func sprawdzPort(_ port: Int) -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/wersja") else { return false }
        var zadanie = URLRequest(url: url)
        zadanie.timeoutInterval = 0.3

        let semafor = DispatchSemaphore(value: 0)
        var znaleziono = false

        let task = URLSession.shared.dataTask(with: zadanie) { dane, _, blad in
            defer { semafor.signal() }
            guard blad == nil, let dane = dane else { return }
            guard let json = try? JSONSerialization.jsonObject(with: dane) as? [String: Any] else { return }
            if (json["app"] as? String) == "radio-rock" {
                znaleziono = true
            }
        }
        task.resume()
        _ = semafor.wait(timeout: .now() + 0.6)
        return znaleziono
    }

    private func uruchomProces() {
        guard let sciezkaServera = Bundle.main.path(forResource: "serwer", ofType: "py") else {
            NSLog("Radio Rock: brak serwer.py w zasobach aplikacji")
            return
        }

        let nowyProces = Process()
        nowyProces.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        nowyProces.arguments = ["python3", sciezkaServera]

        var srodowisko = ProcessInfo.processInfo.environment
        srodowisko["REAKTO_PRZEGLADARKA"] = "brak"
        nowyProces.environment = srodowisko

        nowyProces.standardOutput = FileHandle.nullDevice
        nowyProces.standardError = FileHandle.nullDevice

        do {
            try nowyProces.run()
            self.proces = nowyProces
        } catch {
            NSLog("Radio Rock: nie udalo sie uruchomic serwera python3: \(error)")
        }
    }
}
