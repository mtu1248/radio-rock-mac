import Foundation
import AVFoundation
import CoreMedia
import MediaToolbox
import AudioToolbox

/// Korektor dzwieku (graficzny EQ, 10 pasm) dla Mac 8.4.
///
/// Dziala na SUROWYCH probkach PCM strumienia, wpiety przez MTAudioProcessingTap
/// w AVMutableAudioMix przypiety do AVPlayerItem. To wazne architektonicznie:
/// tap dziala PRZED urzadzeniem wyjsciowym, wiec nie rusza istniejacego
/// mechanizmu `audioOutputDeviceUniqueID` (patrz CLAUDE.md, Mac 8.0) - EQ i
/// wybor wyjscia audio dzialaja niezaleznie i jednoczesnie.
///
/// Implementacja to kaskada 10 filtrow biquad typu "peaking EQ" (wzory z RBJ
/// Audio EQ Cookbook), po jednym na kanal, na stalych czestotliwosciach
/// srodkowych jak w klasycznych 10-pasmowych korektorach graficznych.
/// Wzmocnienie 0 dB na wszystkich pasmach = filtr przezroczysty (brak
/// slyszalnej roznicy), wiec EQ moze zostac wpiety zawsze, bez osobnego
/// mechanizmu wlacz/wylacz - "Płaski" to po prostu wszystkie suwaki na 0.
final class Korektor {

    static let czestotliwosci: [Double] = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
    static let liczbaPasm = czestotliwosci.count

    private var wzmocnienia: [Float]
    private var czestotliwoscProbkowania: Double = 44100
    private var filtry: [[Biquad]] = []   // [kanal][pasmo]
    private let blokada = NSLock()

    init(wzmocnienia: [Float]) {
        self.wzmocnienia = wzmocnienia
    }

    /// Wolane z JS (przez AudioEngine) przy kazdej zmianie suwaka albo presetu.
    func ustawWzmocnienia(_ nowe: [Float]) {
        blokada.lock()
        wzmocnienia = nowe
        przeliczCoefy()
        blokada.unlock()
    }

    /// Wolane z watku audio (callback "prepare" tapu) przy starcie kazdego
    /// nowego itemu - stan filtrow startuje na zero, co jest poprawne (nowy
    /// strumien = nowy sygnal, zadnych "resztek" z poprzedniej stacji).
    fileprivate func przygotuj(liczbaKanalow: Int, fs: Double) {
        blokada.lock()
        czestotliwoscProbkowania = fs > 0 ? fs : 44100
        let kanaly = max(1, liczbaKanalow)
        filtry = (0..<kanaly).map { _ in (0..<Self.liczbaPasm).map { _ in Biquad() } }
        przeliczCoefy()
        blokada.unlock()
    }

    /// Wolane z watku audio (callback "process" tapu) dla kazdego bloku probek.
    fileprivate func przetworz(bufory: UnsafeMutableAudioBufferListPointer) {
        blokada.lock()
        defer { blokada.unlock() }
        guard !filtry.isEmpty else { return }
        for i in 0..<bufory.count {
            guard bufory[i].mNumberChannels == 1, let dane = bufory[i].mData else { continue }
            let liczbaProbek = Int(bufory[i].mDataByteSize) / MemoryLayout<Float>.size
            guard liczbaProbek > 0 else { continue }
            let wskaznik = dane.bindMemory(to: Float.self, capacity: liczbaProbek)
            let kanal = i % filtry.count
            for pasmo in 0..<Self.liczbaPasm {
                filtry[kanal][pasmo].przetworzBlok(wskaznik, liczbaProbek)
            }
        }
    }

    private func przeliczCoefy() {
        guard !filtry.isEmpty else { return }
        for kanal in 0..<filtry.count {
            for pasmo in 0..<Self.liczbaPasm {
                let g = pasmo < wzmocnienia.count ? wzmocnienia[pasmo] : 0
                filtry[kanal][pasmo].ustaw(fs: czestotliwoscProbkowania,
                                            f0: Self.czestotliwosci[pasmo],
                                            gainDB: g, q: 1.0)
            }
        }
    }

    /// Buduje AVAudioMix z tapem EQ podpietym pod podana sciezke audio.
    /// Wolane z AudioEngine po asynchronicznym zaladowaniu sciezki itemu
    /// (nigdy synchronicznie na glownym watku - patrz uwaga w AudioEngine.odtworz).
    func zbudujAudioMix(dla sciezka: AVAssetTrack) -> AVAudioMix? {
        var wywolania = MTAudioProcessingTapCallbacks(
            version: kMTAudioProcessingTapCallbacksVersion_0,
            clientInfo: Unmanaged.passUnretained(self).toOpaque(),
            `init`: korektorTapInit,
            finalize: korektorTapFinalize,
            prepare: korektorTapPrepare,
            unprepare: korektorTapUnprepare,
            process: korektorTapProcess)

        var tapOut: Unmanaged<MTAudioProcessingTap>?
        let status = MTAudioProcessingTapCreate(
            kCFAllocatorDefault, &wywolania,
            kMTAudioProcessingTapCreationFlag_PostEffects, &tapOut)
        guard status == noErr, let tap = tapOut else {
            NSLog("Radio Rock: MTAudioProcessingTapCreate nieudane, status=%d", status)
            return nil
        }

        let parametry = AVMutableAudioMixInputParameters(track: sciezka)
        parametry.audioTapProcessor = tap.takeUnretainedValue()
        let mix = AVMutableAudioMix()
        mix.inputParameters = [parametry]
        return mix
    }
}

/// Filtr biquad "peaking EQ" (Robert Bristow-Johnson, Audio EQ Cookbook),
/// postac Transposed Direct Form II - stabilna numerycznie, tania w liczeniu
/// na probke, standard w softwarowych korektorach graficznych.
private struct Biquad {
    private var b0: Float = 1, b1: Float = 0, b2: Float = 0
    private var a1: Float = 0, a2: Float = 0
    private var z1: Float = 0, z2: Float = 0

    mutating func ustaw(fs: Double, f0: Double, gainDB: Float, q: Double) {
        guard gainDB != 0, fs > 0 else {
            b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0
            return
        }
        let a = pow(10, Double(gainDB) / 40.0)
        let w0 = 2 * Double.pi * f0 / fs
        let cosw0 = cos(w0), sinw0 = sin(w0)
        let alpha = sinw0 / (2 * q)

        let a0d = 1 + alpha / a
        b0 = Float((1 + alpha * a) / a0d)
        b1 = Float((-2 * cosw0) / a0d)
        b2 = Float((1 - alpha * a) / a0d)
        a1 = Float((-2 * cosw0) / a0d)
        a2 = Float((1 - alpha / a) / a0d)
    }

    mutating func przetworzBlok(_ dane: UnsafeMutablePointer<Float>, _ liczba: Int) {
        for i in 0..<liczba {
            let x = dane[i]
            let y = b0 * x + z1
            z1 = b1 * x - a1 * y + z2
            z2 = b2 * x - a2 * y
            dane[i] = y
        }
    }
}

// MARK: - Callbacki C dla MTAudioProcessingTap
//
// Musza byc funkcjami globalnymi (bez przechwytywania kontekstu), zeby Swift
// mogl je uzyc jako wskazniki C. Instancja Korektora jest przekazywana przez
// clientInfo/tapStorage (patrz zbudujAudioMix i korektorTapInit ponizej).

private func korektorTapInit(_ tap: MTAudioProcessingTap,
                              _ clientInfo: UnsafeMutableRawPointer?,
                              _ tapStorageOut: UnsafeMutablePointer<UnsafeMutableRawPointer?>) {
    tapStorageOut.pointee = clientInfo
}

private func korektorTapFinalize(_ tap: MTAudioProcessingTap) {
}

private func korektorTapPrepare(_ tap: MTAudioProcessingTap,
                                 _ maxFrames: CMItemCount,
                                 _ processingFormat: UnsafePointer<AudioStreamBasicDescription>) {
    guard let storage = MTAudioProcessingTapGetStorage(tap) as UnsafeMutableRawPointer? else { return }
    let korektor = Unmanaged<Korektor>.fromOpaque(storage).takeUnretainedValue()
    let format = processingFormat.pointee
    korektor.przygotuj(liczbaKanalow: Int(format.mChannelsPerFrame), fs: format.mSampleRate)
}

private func korektorTapUnprepare(_ tap: MTAudioProcessingTap) {
}

private func korektorTapProcess(_ tap: MTAudioProcessingTap,
                                 _ numberFrames: CMItemCount,
                                 _ flags: MTAudioProcessingTapFlags,
                                 _ bufferListInOut: UnsafeMutablePointer<AudioBufferList>,
                                 _ numberFramesOut: UnsafeMutablePointer<CMItemCount>,
                                 _ flagsOut: UnsafeMutablePointer<MTAudioProcessingTapFlags>) {
    let status = MTAudioProcessingTapGetSourceAudio(tap, numberFrames, bufferListInOut, flagsOut, nil, numberFramesOut)
    guard status == noErr else { return }
    guard let storage = MTAudioProcessingTapGetStorage(tap) as UnsafeMutableRawPointer? else { return }
    let korektor = Unmanaged<Korektor>.fromOpaque(storage).takeUnretainedValue()
    let bufory = UnsafeMutableAudioBufferListPointer(bufferListInOut)
    korektor.przetworz(bufory: bufory)
}
