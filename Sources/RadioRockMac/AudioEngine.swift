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
    private var czasStartu: Date?
    private var ostatniaGlosnosc: Float = 1.0
    private var ostatnieWyciszenie = false

    // Korektor dzwieku (Mac 8.4) - patrz Korektor.swift. Domyslnie "plaski"
    // (wszystkie pasma 0 dB), nadpisywane w wczytajKorektor() z UserDefaults.
    private let korektor = Korektor(wzmocnienia: Array(repeating: 0, count: Korektor.liczbaPasm))
    private(set) var wzmocnieniaKorektora: [Float] = Array(repeating: 0, count: Korektor.liczbaPasm)

    private var timerTytulu: Timer?
    private var timerPuls: Timer?
    private var timerPonowienia: Timer?
    private var probaPonowienia = 0
    private let odstepyPonowien: [TimeInterval] = [2, 4, 6, 8, 10]

    private var monitorSieci: NWPathMonitor?
    private let kolejkaSieci = DispatchQueue(label: "pl.reakto.radiorock.siec")

    override init() {
        super.init()
        wczytajKorektor()
        wystartujMonitorSieci()
        timerPuls = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            self?.pulsKontrolny()
        }
    }

    // MARK: - Sterowanie (wywolywane z mostka JS albo klawiszy multimedialnych)

    func ustawListe(_ nowaKolejka: [StacjaKolejki], indeks nowyIndeks: Int) {
        kolejka = nowaKolejka
        celowoZatrzymany = false
        odtworz(indeks: nowyIndeks, powod: "ustawListe")
    }

    func przelacz(powod: String = "JS") {
        NSLog("Radio Rock: przelacz() powod=%@", powod)
        guard player != nil else { return }
        if celowoZatrzymany || player?.timeControlStatus == .paused {
            wznow(powod: powod)
        } else {
            pauza(powod: powod)
        }
    }

    func wznow(powod: String = "JS") {
        NSLog("Radio Rock: wznow() powod=%@", powod)
        celowoZatrzymany = false
        if player == nil, !kolejka.isEmpty {
            odtworz(indeks: indeks, powod: "wznow-playerNil/\(powod)")
            return
        }
        player?.play()
        wyslijStan()
    }

    func pauza(powod: String = "JS") {
        NSLog("Radio Rock: pauza() powod=%@", powod)
        celowoZatrzymany = true
        player?.pause()
        timerPonowienia?.invalidate()
        czasStartu = nil
        wyslijStan()
    }

    // Kazda zmiana stacji jest logowana z "powodem" - to jedyny sposob, zeby
    // odroznic w logach klik strony, klawisz multimedialny/gest AirPods,
    // watchdog i automatyczny retry. Bez tego nie da sie ustalic, co
    // faktycznie przelacza stacje w tle (patrz CLAUDE.md, runda 6).
    func nastepna(powod: String = "JS") { przejdz(o: 1, powod: powod) }
    func poprzednia(powod: String = "JS") { przejdz(o: -1, powod: powod) }

    private func przejdz(o krok: Int, powod: String) {
        guard !kolejka.isEmpty else { return }
        indeks = ((indeks + krok) % kolejka.count + kolejka.count) % kolejka.count
        NSLog("Radio Rock: przejdz(o: %d) -> nowy indeks %d, powod=%@", krok, indeks, powod)
        odtworz(indeks: indeks, powod: "przejdz/\(powod)")
    }

    func ustawGlosnosc(_ wartosc: Float) {
        ostatniaGlosnosc = wartosc
        player?.volume = wartosc
    }

    func ustawWyciszenie(_ czy: Bool) {
        ostatnieWyciszenie = czy
        player?.isMuted = czy
    }

    /// Odswiez = ponowne zaladowanie biezacej stacji (dla zywego strumienia
    /// nie ma czego "przewijac" - to po prostu swiezy start).
    func odswiez(powod: String = "JS") {
        guard !kolejka.isEmpty else { return }
        odtworz(indeks: indeks, powod: "odswiez/\(powod)")
    }

    func restartPolaczenia(powod: String = "JS") {
        odswiez(powod: "restartPolaczenia/\(powod)")
    }

    func ustawUrzadzenieWyjsciowe(_ uid: String?) {
        wybraneUrzadzenieUID = (uid?.isEmpty ?? true) ? nil : uid
        player?.audioOutputDeviceUniqueID = wybraneUrzadzenieUID
    }

    /// Korektor dzwieku - 10 pasm, wartosci w dB (-12...+12). Wywolywane z
    /// mostka JS przy kazdym ruchu suwaka albo wyborze presetu (patrz app.js /
    /// WebBridge.swift). Dziala natychmiast, bez potrzeby wznawiania strumienia,
    /// i jest trwale zapamietywane w UserDefaults.
    func ustawKorektor(_ pasma: [Float]) {
        guard pasma.count == Korektor.liczbaPasm else { return }
        wzmocnieniaKorektora = pasma
        korektor.ustawWzmocnienia(pasma)
        if let dane = try? JSONEncoder().encode(pasma) {
            UserDefaults.standard.set(dane, forKey: "korektorPasma")
        }
    }

    private func wczytajKorektor() {
        guard let dane = UserDefaults.standard.data(forKey: "korektorPasma"),
              let odkodowane = try? JSONDecoder().decode([Float].self, from: dane),
              odkodowane.count == Korektor.liczbaPasm else { return }
        wzmocnieniaKorektora = odkodowane
        korektor.ustawWzmocnienia(odkodowane)
    }

    /// Podpina EQ pod nowy item asynchronicznie. AVAsset.tracks(withMediaType:)
    /// synchroniczne byloby blokujace (przestarzale) - appka juz raz nauczyla
    /// sie kosztownie, jak drogo wychodzi kazde nowe zrodlo zawiechy przy
    /// starcie odtwarzania (patrz CLAUDE.md, "Pulapki"), wiec EQ idzie w pelni
    /// asynchronicznie i nigdy nie blokuje glownego watku ani startu grania.
    private func ustawKorektorNaItem(_ item: AVPlayerItem) {
        Task { [weak self, weak item] in
            guard let self = self, let item = item else { return }
            guard let sciezka = (try? await item.asset.loadTracks(withMediaType: .audio))?.first else { return }
            guard let mix = self.korektor.zbudujAudioMix(dla: sciezka) else { return }
            await MainActor.run {
                guard item === self.player?.currentItem else { return }
                item.audioMix = mix
            }
        }
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

    /// AVPlayer nie rozumie ICY (status "ICY 200 OK", metadane wplecione w
    /// bajty audio) - stacje bywaja takim starym Shoutcastem, i wlasnie dlatego
    /// appka NIGDY nie laczy sie z nimi bezposrednio. Zawsze idzie przez lokalny
    /// serwer (/api/strumien), ktory juz umie to wszystko obsluzyc (patrz
    /// serwer.py: _polacz/przekaz_strumien) i oddaje AVPlayerowi czysty dzwiek.
    private func adresDoOdtwarzania(_ adresStacji: String) -> URL? {
        guard let bazowy = adresBazowy,
              let zakodowany = adresStacji.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) else {
            return URL(string: adresStacji)
        }
        return URL(string: "\(bazowy)api/strumien?url=\(zakodowany)")
    }

    private func odtworz(indeks nowyIndeks: Int, powod: String) {
        guard kolejka.indices.contains(nowyIndeks) else { return }
        NSLog("Radio Rock: odtworz(indeks: %d, stacja: %@) powod=%@",
              nowyIndeks, kolejka[nowyIndeks].nazwa, powod)
        indeks = nowyIndeks
        celowoZatrzymany = false
        probaPonowienia = 0
        oczekiwanieOd = nil
        czasStartu = Date()
        timerPonowienia?.invalidate()

        let stacja = kolejka[nowyIndeks]
        guard let url = adresDoOdtwarzania(stacja.url) else {
            wyslijBlad()
            return
        }

        NotificationCenter.default.removeObserver(self)
        obserwacjaStatus = nil
        obserwacjaCzasKontroli = nil
        player?.pause()

        let item = AVPlayerItem(url: url)
        let nowyPlayer = AVPlayer(playerItem: item)
        // Runda 5-6 mialy tu `automaticallyWaitsToMinimizeStalling = false`
        // (zeby przyspieszyc start zywych strumieni), ale to wlasnie okazalo
        // sie przyczyna nowego, cichszego bledu: AVPlayer wchodzil w
        // timeControlStatus == .playing, sygnalizowal appce i JS-owi ze gra,
        // a fizycznie CoreAudio nigdy nie budowal potoku dzwieku (zero
        // dzwieku, zero ruchu na wskazniku glosnosci systemu, zero sladu
        // HALC/FigStreamPlayer w logu). Dowod: QuickTime Player, ktory uzywa
        // dokladnie tego samego AVPlayera z DOMYSLNYMI ustawieniami, na tym
        // samym strumieniu z /api/strumien, gral bez zarzutu. Jedyna
        // nietypowa roznica w naszym kodzie to wlasnie ta flaga - wracamy do
        // domyslnego `true`. Ryzyko "czeka w nieskonczonosc na bufor" jest
        // juz i tak pokryte dwoma niezaleznymi watchdogami w pulsKontrolny().
        nowyPlayer.automaticallyWaitsToMinimizeStalling = true
        if let uid = wybraneUrzadzenieUID, !uid.isEmpty {
            nowyPlayer.audioOutputDeviceUniqueID = uid
        }
        nowyPlayer.volume = ostatniaGlosnosc
        nowyPlayer.isMuted = ostatnieWyciszenie
        player = nowyPlayer
        ustawKorektorNaItem(item)

        obserwacjaStatus = item.observe(\.status, options: [.new]) { [weak self] item, _ in
            DispatchQueue.main.async {
                guard let self = self else { return }
                switch item.status {
                case .failed:
                    if let blad = item.error {
                        NSLog("Radio Rock: item.status = failed: %@", blad as NSError)
                    }
                    self.zaplanujPonowienie()
                case .readyToPlay:
                    self.probaPonowienia = 0
                    // Belt-and-suspenders: gdyby play() wywolane przed
                    // gotowoscia itemu nie "zlapalo sie" poprawnie (podejrzenie
                    // z rundy 7 - cichy playing bez dzwieku), zadajemy
                    // odtwarzania jeszcze raz teraz, gdy item na pewno jest
                    // gotowy. Bezpieczne i tanie do powtorzenia.
                    self.player?.play()
                default:
                    break
                }
            }
        }

        obserwacjaCzasKontroli = nowyPlayer.observe(\.timeControlStatus, options: [.new]) { [weak self] player, _ in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.oczekiwanieOd = (player.timeControlStatus == .waitingToPlayAtSpecifiedRate) ? Date() : nil
                if player.timeControlStatus == .playing { self.czasStartu = nil }
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
        if let blad = powiadomienie.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? NSError {
            NSLog("Radio Rock: nieudane odtwarzanie: %@", blad)
        }
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
            self.odtworz(indeks: self.indeks, powod: "auto-retry#\(self.probaPonowienia)")
        }
    }

    /// Puls co 10 s, niezalezny od konkretnego zdarzenia bledu - lekcja z
    /// Androida: odtwarzacz potrafi utknac w buforowaniu bez zgloszenia bledu.
    private func pulsKontrolny() {
        guard !celowoZatrzymany, !kolejka.isEmpty else { return }
        if let od = oczekiwanieOd, Date().timeIntervalSince(od) > 20 {
            oczekiwanieOd = nil
            odtworz(indeks: indeks, powod: "watchdog-utknal-w-buforowaniu(>20s)")
            return
        }
        // Zabezpieczenie na wypadek, gdy AVPlayer po .play() w ogole nie ruszy
        // stanu (nie wejdzie nawet w waitingToPlayAtSpecifiedRate) - obserwowane
        // przy "zimnym" starcie appki: zero bledow, zero zmian stanu, cisza w
        // nieskonczonosc (timeControlStatus utyka na .paused). Stary puls tego
        // nie lapal, bo pilnowal tylko przypadku "utknal w buforowaniu", a nie
        // "nigdy nawet nie zaczal". Dajemy 12 s od proby, potem twardy restart.
        if let start = czasStartu, Date().timeIntervalSince(start) > 12 {
            czasStartu = nil
            odtworz(indeks: indeks, powod: "watchdog-nigdy-nie-ruszyl(>12s)")
        }
    }

    private func wznowNatychmiast() {
        guard !celowoZatrzymany, !kolejka.isEmpty else { return }
        odtworz(indeks: indeks, powod: "siec-przywrocona")
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
        let gra = !celowoZatrzymany && player?.timeControlStatus == .playing
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
