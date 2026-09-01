import AVFoundation
import Network
import MediaPlayer

struct StacjaKolejki {
    let nazwa: String
    let url: String
}

private extension Array {
    subscript(bezpiecznie indeks: Int) -> Element? {
        indices.contains(indeks) ? self[indeks] : nil
    }
}

/// Silnik odtwarzania - AVPlayer zamiast elementu <audio> w przegladarce.
/// Dzieki temu strumien mozna skierowac na wybrane urzadzenie wyjsciowe
/// (audioOutputDeviceUniqueID), niezaleznie od domyslnego wyjscia systemu.
///
/// Logika wznawiania po utracie sieci powtarza lekcje z wersji androidowej
/// (patrz CLAUDE.md, wersje 6.6/7.2): odstepy ponowien 2/4/6/8/10 s, natychmiastowe
/// wznowienie po powrocie sieci (NWPathMonitor) i niezalezny puls co 10 s na
/// wypadek, gdyby odtwarzacz utknal w buforowaniu bez zadnego bledu.
final class AudioEngine: NSObject {

    weak var webBridge: WebBridge?
    var wybraneUrzadzenieUID: String?
    var adresBazowy: String?

    private var player: AVPlayer?
    private var kolejka: [StacjaKolejki] = []
    private var indeks: Int = 0
    private var celowoZatrzymany = false

    private var obserwacjaStatus: NSKeyValueObservation?
    private var obserwacjaCzasKontroli: NSKeyValueObservation?
    private var oczekiwanieOd: Date?

    private var timerTytulu: Timer?
    private var timerPuls: Timer?
    private var timerPonowienia: Timer?
    private var probaPonowienia = 0
    private let odstepyPonowien: [TimeInterval] = [2, 4, 6, 8, 10]

    private var monitorSieci: NWPathMonitor?
    private let kolejkaSieci = DispatchQueue(label: "pl.reakto.radiorock.siec")

    override init() {
        super.init()
        wystartujMonitorSieci()
        timerPuls = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            self?.pulsKontrolny()
        }
    }

    // MARK: - Sterowanie (wywolywane z mostka JS albo klawiszy multimedialnych)

    func ustawListe(_ nowaKolejka: [StacjaKolejki], indeks nowyIndeks: Int) {
        kolejka = nowaKolejka
        celowoZatrzymany = false
        odtworz(indeks: nowyIndeks)
    }

    func przelacz() {
        guard player != nil else { return }
        if celowoZatrzymany || player?.timeControlStatus == .paused {
            wznow()
        } else {
            pauza()
        }
    }

    func wznow() {
        celowoZatrzymany = false
        if player == nil, !kolejka.isEmpty {
            odtworz(indeks: indeks)
            return
        }
        player?.play()
        wyslijStan()
    }

    func pauza() {
        celowoZatrzymany = true
        player?.pause()
        timerPonowienia?.invalidate()
        wyslijStan()
    }

    func nastepna() { przejdz(o: 1) }
    func poprzednia() { przejdz(o: -1) }

    private func przejdz(o krok: Int) {
        guard !kolejka.isEmpty else { return }
        indeks = ((indeks + krok) % kolejka.count + kolejka.count) % kolejka.count
        odtworz(indeks: indeks)
    }

    func ustawGlosnosc(_ wartosc: Float) {
        player?.volume = wartosc
    }

    func ustawWyciszenie(_ czy: Bool) {
        player?.isMuted = czy
    }

    /// Odswiez = ponowne zaladowanie biezacej stacji (dla zywego strumienia
    /// nie ma czego "przewijac" - to po prostu swiezy start).
    func odswiez() {
        guard !kolejka.isEmpty else { return }
        odtworz(indeks: indeks)
    }

    func restartPolaczenia() {
        odswiez()
    }

    func ustawUrzadzenieWyjsciowe(_ uid: String?) {
        wybraneUrzadzenieUID = uid
        player?.audioOutputDeviceUniqueID = uid
    }

    func zatrzymaj() {
        celowoZatrzymany = true
        player?.pause()
        zatrzymajTimerTytulu()
        timerPuls?.invalidate()
        timerPonowienia?.invalidate()
        monitorSieci?.cancel()
        NotificationCenter.default.removeObserver(self)
    }

    // MARK: - Odtwarzanie

    private func odtworz(indeks nowyIndeks: Int) {
        guard kolejka.indices.contains(nowyIndeks) else { return }
        indeks = nowyIndeks
        celowoZatrzymany = false
        probaPonowienia = 0
        oczekiwanieOd = nil
        timerPonowienia?.invalidate()

        let stacja = kolejka[nowyIndeks]
        guard let url = URL(string: stacja.url) else {
            wyslijBlad()
            return
        }

        NotificationCenter.default.removeObserver(self)
        obserwacjaStatus = nil
        obserwacjaCzasKontroli = nil
        player?.pause()

        let item = AVPlayerItem(url: url)
        let nowyPlayer = AVPlayer(playerItem: item)
        // Wazne dla zywych strumieni: domyslny algorytm AVPlayera potrafi
        // czekac w nieskonczonosc na "lepszy" bufor przy strumieniu bez
        // znanego czasu trwania. Wylaczamy to i puszczamy od razu.
        nowyPlayer.automaticallyWaitsToMinimizeStalling = false
        nowyPlayer.audioOutputDeviceUniqueID = wybraneUrzadzenieUID
        player = nowyPlayer

        obserwacjaStatus = item.observe(\.status, options: [.new]) { [weak self] item, _ in
            DispatchQueue.main.async {
                guard let self = self else { return }
                switch item.status {
                case .failed:
                    self.zaplanujPonowienie()
                case .readyToPlay:
                    self.probaPonowienia = 0
                default:
                    break
                }
            }
        }

        obserwacjaCzasKontroli = nowyPlayer.observe(\.timeControlStatus, options: [.new]) { [weak self] player, _ in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.oczekiwanieOd = (player.timeControlStatus == .waitingToPlayAtSpecifiedRate) ? Date() : nil
                self.wyslijStan()
            }
        }

        NotificationCenter.default.addObserver(self, selector: #selector(bladOdtwarzania(_:)),
                                                name: .AVPlayerItemFailedToPlayToEndTime, object: item)

        nowyPlayer.play()
        wyslijStacja(indeks: nowyIndeks)
        wyslijStan()
        ustawNowyTytul(stacja: stacja, tytul: "")
        uruchomTimerTytulu()
    }

    @objc private func bladOdtwarzania(_ powiadomienie: Notification) {
        zaplanujPonowienie()
    }

    private func zaplanujPonowienie() {
        guard !celowoZatrzymany else { return }
        wyslijBlad()
        let opoznienie = odstepyPonowien[min(probaPonowienia, odstepyPonowien.count - 1)]
        probaPonowienia += 1
        timerPonowienia?.invalidate()
        timerPonowienia = Timer.scheduledTimer(withTimeInterval: opoznienie, repeats: false) { [weak self] _ in
            guard let self = self, !self.celowoZatrzymany else { return }
            self.odtworz(indeks: self.indeks)
        }
    }

    /// Puls co 10 s, niezalezny od konkretnego zdarzenia bledu - lekcja z
    /// Androida: odtwarzacz potrafi utknac w buforowaniu bez zgloszenia bledu.
    private func pulsKontrolny() {
        guard !celowoZatrzymany, !kolejka.isEmpty else { return }
        if let od = oczekiwanieOd, Date().timeIntervalSince(od) > 20 {
            oczekiwanieOd = nil
            odtworz(indeks: indeks)
        }
    }

    private func wznowNatychmiast() {
        guard !celowoZatrzymany, !kolejka.isEmpty else { return }
        odtworz(indeks: indeks)
    }

    // MARK: - Siec

    private func wystartujMonitorSieci() {
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] sciezka in
            guard sciezka.status == .satisfied else { return }
            DispatchQueue.main.async { self?.wznowNatychmiast() }
        }
        monitor.start(queue: kolejkaSieci)
        monitorSieci = monitor
    }

    // MARK: - Tytul utworu (ICY przez lokalny serwer /api/utwor)

    private func uruchomTimerTytulu() {
        zatrzymajTimerTytulu()
        timerTytulu = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            self?.pobierzTytul()
        }
        pobierzTytul()
    }

    private func zatrzymajTimerTytulu() {
        timerTytulu?.invalidate()
        timerTytulu = nil
    }

    private func pobierzTytul() {
        guard let adresBazowy = adresBazowy, kolejka.indices.contains(indeks) else { return }
        let stacja = kolejka[indeks]
        guard let zakodowany = stacja.url.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let url = URL(string: "\(adresBazowy)api/utwor?url=\(zakodowany)") else { return }

        let biezacyIndeks = indeks
        URLSession.shared.dataTask(with: url) { [weak self] dane, _, blad in
            guard let self = self, blad == nil, let dane = dane else { return }
            guard let json = try? JSONSerialization.jsonObject(with: dane) as? [String: Any] else { return }
            let tytul = json["tytul"] as? String
            DispatchQueue.main.async {
                guard biezacyIndeks == self.indeks else { return }
                self.ustawNowyTytul(stacja: self.kolejka[bezpiecznie: biezacyIndeks], tytul: tytul ?? "")
            }
        }.resume()
    }

    // MARK: - Wysylki do JS i do centrum sterowania systemu

    private func wyslijStan() {
        let gra = !celowoZatrzymany && player?.timeControlStatus != .paused
        webBridge?.wyslijDoJS?("window.zNatywnego_stan && window.zNatywnego_stan(\(gra));")
        MPNowPlayingInfoCenter.default().playbackState = gra ? .playing : .paused
    }

    private func wyslijStacja(indeks: Int) {
        webBridge?.wyslijDoJS?("window.zNatywnego_stacja && window.zNatywnego_stacja(\(indeks));")
    }

    private func wyslijBlad() {
        webBridge?.wyslijDoJS?("window.zNatywnego_blad && window.zNatywnego_blad();")
    }

    private func ustawNowyTytul(stacja: StacjaKolejki?, tytul: String) {
        webBridge?.wyslijDoJS?("window.zNatywnego_tytul && window.zNatywnego_tytul(\(jsString(tytul)));")

        var info: [String: Any] = [:]
        info[MPMediaItemPropertyTitle] = tytul.isEmpty ? (stacja?.nazwa ?? "Radio Rock") : tytul
        info[MPMediaItemPropertyArtist] = stacja?.nazwa ?? "Radio Rock"
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }
}
