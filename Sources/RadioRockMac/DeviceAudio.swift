import CoreAudio
import Foundation

struct UrzadzenieAudio {
    let uid: String
    let nazwa: String
}

/// Lista urzadzen wyjsciowych dzwieku widocznych w systemie (CoreAudio) plus
/// nasluch na ich pojawianie/znikanie - np. podlaczenie glosnika Bluetooth
/// odswieza liste automatycznie, bez ponownego otwierania aplikacji.
final class DeviceAudio {

    private(set) var urzadzenia: [UrzadzenieAudio] = []
    var naZmiane: (() -> Void)?

    func wystartuj() {
        odswiez()
        var adres = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        _ = AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &adres, DispatchQueue.main) { [weak self] _, _ in
            self?.odswiez()
        }
    }

    private func odswiez() {
        urzadzenia = pobierzUrzadzeniaWyjsciowe()
        naZmiane?()
    }

    private func pobierzUrzadzeniaWyjsciowe() -> [UrzadzenieAudio] {
        var adres = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)

        var rozmiar: UInt32 = 0
        var status = AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &adres, 0, nil, &rozmiar)
        guard status == noErr, rozmiar > 0 else { return [] }

        let liczbaUrzadzen = Int(rozmiar) / MemoryLayout<AudioDeviceID>.size
        var identyfikatory = [AudioDeviceID](repeating: 0, count: liczbaUrzadzen)
        status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &adres, 0, nil, &rozmiar, &identyfikatory)
        guard status == noErr else { return [] }

        var wynik: [UrzadzenieAudio] = []
        for id in identyfikatory {
            guard maWyjscie(id), let uid = pobierzUID(id), let nazwa = pobierzNazwe(id) else { continue }
            wynik.append(UrzadzenieAudio(uid: uid, nazwa: nazwa))
        }
        return wynik
    }

    private func maWyjscie(_ id: AudioDeviceID) -> Bool {
        var adres = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreams,
            mScope: kAudioObjectPropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain)
        var rozmiar: UInt32 = 0
        let status = AudioObjectGetPropertyDataSize(id, &adres, 0, nil, &rozmiar)
        return status == noErr && rozmiar > 0
    }

    private func pobierzUID(_ id: AudioDeviceID) -> String? {
        var adres = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var cfString: CFString = "" as CFString
        var rozmiar = UInt32(MemoryLayout<CFString>.size)
        let status = withUnsafeMutablePointer(to: &cfString) { wskaznik -> OSStatus in
            AudioObjectGetPropertyData(id, &adres, 0, nil, &rozmiar, wskaznik)
        }
        guard status == noErr else { return nil }
        return cfString as String
    }

    private func pobierzNazwe(_ id: AudioDeviceID) -> String? {
        var adres = AudioObjectPropertyAddress(
            mSelector: kAudioObjectPropertyName,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var cfString: CFString = "" as CFString
        var rozmiar = UInt32(MemoryLayout<CFString>.size)
        let status = withUnsafeMutablePointer(to: &cfString) { wskaznik -> OSStatus in
            AudioObjectGetPropertyData(id, &adres, 0, nil, &rozmiar, wskaznik)
        }
        guard status == noErr else { return nil }
        return cfString as String
    }
}
