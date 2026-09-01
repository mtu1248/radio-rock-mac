#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Radio Rock - lokalny serwer aplikacji.

Dwa zadania:
1. serwuje pliki aplikacji z katalogu www (przegladarka nie moze ich otworzyc
   bezposrednio z dysku, bo blokuje wtedy zapytania do strumieni),
2. udostepnia /api/utwor?url=... - odczytuje metadane ICY ze strumienia
   radiowego i zwraca tytul aktualnie granego utworu. Przegladarka sama tego
   nie potrafi, bo tytul jest wpleciony w dane audio, a nie w strone.

Uruchamiane przez URUCHOM_radio.command. Nie wymaga zadnych bibliotek
poza standardowa biblioteka Pythona 3.
"""

import http.server
import socketserver
import socket
import ssl
import subprocess
import json
import os
import sys
import threading
import time
import urllib.parse
import urllib.request
import webbrowser

# Porty innych narzedzi na tym Macu: Dziennik 8080, Panel Statystyk 8765-8769,
# Tablica zmian 8770-8780. Radio siedzi wyzej, zeby sobie nie wchodzily w droge.
PORT = 8790
KATALOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "www")

# Ktora przegladarka ma sie otworzyc: "domyslna", "safari", "chrome" albo "brak".
# Ustawiane przez plik uruchamiajacy (URUCHOM_radio.command / URUCHOM_w_Safari.command).
PRZEGLADARKA = os.environ.get("REAKTO_PRZEGLADARKA", "domyslna").strip().lower()

NAZWY_PRZEGLADAREK = {"safari": "Safari", "chrome": "Google Chrome", "firefox": "Firefox"}


def katalog_danych():
    """Wlasne stacje trzymamy poza folderem programu - przezyja podmiane wersji.
    Wnetrze pakietu .app w /Applications nie jest zapisywalne, wiec nigdy
    nie zapisujemy obok programu, jesli tylko istnieje katalog uzytkownika."""
    kandydaci = []
    if os.environ.get("REAKTO_HOME"):
        kandydaci.append(os.environ["REAKTO_HOME"])
    if sys.platform == "darwin":
        kandydaci.append(os.path.expanduser("~/Library/Application Support/Radio Rock"))
    kandydaci.append(os.path.expanduser("~/.radio-rock"))
    kandydaci.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), "dane"))

    for sciezka in kandydaci:
        try:
            os.makedirs(sciezka, exist_ok=True)
            proba = os.path.join(sciezka, ".proba-zapisu")
            with open(proba, "w") as plik:
                plik.write("ok")
            os.remove(proba)
            return sciezka
        except Exception:
            continue
    return os.path.expanduser("~")


PLIK_MOICH_STACJI = os.path.join(katalog_danych(), "moje_stacje.json")


def wczytaj_moje_stacje():
    """Zwraca {"moje": [...], "ukryte": [...]}. Przyjmuje tez starszy format
    (sama lista stacji), zeby nie zgubic tego, co juz zapisane."""
    try:
        with open(PLIK_MOICH_STACJI, encoding="utf-8") as plik:
            dane = json.load(plik)
    except Exception:
        return {"moje": [], "ukryte": []}

    if isinstance(dane, list):
        return {"moje": dane, "ukryte": []}
    if isinstance(dane, dict):
        return {
            "moje": dane.get("moje") if isinstance(dane.get("moje"), list) else [],
            "ukryte": dane.get("ukryte") if isinstance(dane.get("ukryte"), list) else [],
        }
    return {"moje": [], "ukryte": []}


def zapisz_moje_stacje(dane):
    # katalog moze zniknac miedzy startem a zapisem - upewniamy sie za kazdym razem
    os.makedirs(os.path.dirname(PLIK_MOICH_STACJI), exist_ok=True)
    with open(PLIK_MOICH_STACJI, "w", encoding="utf-8") as plik:
        json.dump(dane, plik, ensure_ascii=False, indent=1)


def otworz_okno(adres):
    """Otwiera adres we wskazanej przegladarce. Gdy sie nie uda, wraca do domyslnej."""
    if PRZEGLADARKA == "brak":
        return
    nazwa = NAZWY_PRZEGLADAREK.get(PRZEGLADARKA)
    if nazwa and sys.platform == "darwin":
        try:
            subprocess.run(["open", "-a", nazwa, adres], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return
        except Exception:
            print("  Nie udalo sie otworzyc przegladarki %s - otwieram domyslna." % nazwa)
    webbrowser.open(adres)

# Pamiec podreczna tytulow: url -> (czas_pobrania, tytul)
_cache = {}
_cache_lock = threading.Lock()
CACHE_SEKUND = 10

TYPY_MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


# Radio Browser - otwarta baza kilkudziesieciu tysiecy stacji, bez kluczy i oplat.
SERWERY_BAZY = [
    "https://de1.api.radio-browser.info",
    "https://nl1.api.radio-browser.info",
    "https://at1.api.radio-browser.info",
]


def szukaj_w_bazie(fraza, limit=60, kraj=""):
    """Szuka stacji po nazwie. Pusta fraza zwraca gotowa liste najczesciej
    sluchanych stacji (domyslnie polskich), zeby bylo od czego zaczac.
    Serwery bazy bywaja chwilowo niedostepne, wiec probujemy kolejno kilku."""
    parametry = {
        "limit": limit,
        "hidebroken": "true",
        "order": "clickcount",
        "reverse": "true",
    }
    if fraza:
        parametry["name"] = fraza
    if kraj:
        parametry["countrycode"] = kraj
    zapytanie = urllib.parse.urlencode(parametry)

    ostatni_blad = "brak odpowiedzi"
    for serwer in SERWERY_BAZY:
        try:
            zadanie = urllib.request.Request(
                serwer + "/json/stations/search?" + zapytanie,
                headers={"User-Agent": "RadioRock/5.1 (prywatne radio)",
                         "Accept": "application/json"},
            )
            with urllib.request.urlopen(zadanie, timeout=10) as odp:
                dane = json.loads(odp.read().decode("utf-8"))
            break
        except Exception as blad:
            ostatni_blad = str(blad)
    else:
        return {"ok": False, "powod": ostatni_blad, "wyniki": []}

    wyniki = []
    widziane = set()
    for stacja in dane:
        adres = (stacja.get("url_resolved") or stacja.get("url") or "").strip()
        nazwa = (stacja.get("name") or "").strip()[:60]
        if not nazwa or not adres.lower().startswith(("http://", "https://")):
            continue
        if adres in widziane:
            continue
        widziane.add(adres)
        wyniki.append({
            "nazwa": nazwa,
            "url": adres,
            "kraj": (stacja.get("country") or "").strip()[:30],
            "tagi": (stacja.get("tags") or "").strip()[:60],
            "kodek": (stacja.get("codec") or "").strip()[:10],
            "bitrate": stacja.get("bitrate") or 0,
        })
    return {"ok": True, "powod": None, "wyniki": wyniki}


def _polacz(url, pozostale_przekierowania=3, icy_metadata=True):
    """Wlasny klient HTTP. Biblioteka standardowa odrzuca odpowiedzi serwerow
    Shoutcast, ktore zaczynaja sie od "ICY 200 OK" zamiast "HTTP/1.1 200 OK",
    dlatego status i naglowki czytamy sami.

    icy_metadata=False jest uzywane przy przekazywaniu strumienia dalej do
    natywnej appki (AVPlayer) - nie chcemy metadanych wplecionych w bajty
    audio, appka i tak dostaje tytul osobno przez /api/utwor."""
    czesci = urllib.parse.urlsplit(url)
    host = czesci.hostname
    if not host:
        raise ValueError("bledny adres")
    port = czesci.port or (443 if czesci.scheme == "https" else 80)
    sciezka = czesci.path or "/"
    if czesci.query:
        sciezka += "?" + czesci.query

    gniazdo = socket.create_connection((host, port), timeout=8)
    if czesci.scheme == "https":
        kontekst = ssl.create_default_context()
        gniazdo = kontekst.wrap_socket(gniazdo, server_hostname=host)

    naglowek_icy = "Icy-MetaData: 1\r\n" if icy_metadata else ""
    zapytanie = (
        "GET %s HTTP/1.1\r\n"
        "Host: %s\r\n"
        "User-Agent: Mozilla/5.0 (Macintosh) RadioRock/1.0\r\n"
        "%s"
        "Accept: */*\r\n"
        "Connection: close\r\n\r\n"
    ) % (sciezka, czesci.netloc, naglowek_icy)
    gniazdo.sendall(zapytanie.encode("utf-8"))
    strumien = gniazdo.makefile("rb")

    linia_statusu = strumien.readline().decode("iso-8859-1").strip()
    czlony = linia_statusu.split(None, 2)
    try:
        kod = int(czlony[1])
    except (IndexError, ValueError):
        kod = 200 if linia_statusu.upper().startswith("ICY") else 0

    naglowki = {}
    while True:
        linia = strumien.readline()
        if not linia or linia in (b"\r\n", b"\n"):
            break
        tekst = linia.decode("iso-8859-1").strip()
        if ":" in tekst:
            klucz, wartosc = tekst.split(":", 1)
            naglowki[klucz.strip().lower()] = wartosc.strip()

    if kod in (301, 302, 303, 307, 308) and naglowki.get("location"):
        strumien.close()
        gniazdo.close()
        if pozostale_przekierowania <= 0:
            raise ValueError("zbyt wiele przekierowan")
        nowy_adres = urllib.parse.urljoin(url, naglowki["location"])
        return _polacz(nowy_adres, pozostale_przekierowania - 1, icy_metadata)

    if kod >= 400:
        strumien.close()
        gniazdo.close()
        raise ValueError("serwer odpowiedzial kodem %d" % kod)

    return gniazdo, strumien, naglowki


def pobierz_tytul(url, limit_prob=4):
    """Odczytuje tytul granego utworu z metadanych ICY wplecionych w strumien."""
    gniazdo, strumien, naglowki = _polacz(url)
    try:
        nazwa_stacji = naglowki.get("icy-name")
        metaint = naglowki.get("icy-metaint")
        if not metaint:
            return {"tytul": None, "stacja": nazwa_stacji, "powod": "brak metadanych"}
        metaint = int(metaint)

        # Pierwszy blok metadanych bywa pusty - probujemy kilka razy.
        for _ in range(limit_prob):
            do_pominiecia = metaint
            while do_pominiecia > 0:
                porcja = strumien.read(min(8192, do_pominiecia))
                if not porcja:
                    return {"tytul": None, "stacja": nazwa_stacji, "powod": "strumien urwany"}
                do_pominiecia -= len(porcja)

            bajt_dlugosci = strumien.read(1)
            if not bajt_dlugosci:
                return {"tytul": None, "stacja": nazwa_stacji, "powod": "strumien urwany"}
            dlugosc = bajt_dlugosci[0] * 16
            if dlugosc == 0:
                continue

            surowe = b""
            while len(surowe) < dlugosc:
                porcja = strumien.read(dlugosc - len(surowe))
                if not porcja:
                    break
                surowe += porcja
            tekst = surowe.decode("utf-8", "replace")

            znacznik = "StreamTitle='"
            poczatek = tekst.find(znacznik)
            if poczatek == -1:
                continue
            poczatek += len(znacznik)
            koniec = tekst.find("';", poczatek)
            if koniec == -1:
                koniec = len(tekst)
            tytul = tekst[poczatek:koniec].strip()
            if tytul:
                return {"tytul": tytul, "stacja": nazwa_stacji, "powod": None}

        return {"tytul": None, "stacja": nazwa_stacji, "powod": "stacja nie podaje tytulu"}
    finally:
        try:
            strumien.close()
            gniazdo.close()
        except Exception:
            pass


def sprawdz_stacje(url):
    """Sprawdza, czy adres odpowiada strumieniem audio. Gdy trafi na plik
    playlisty (.m3u/.pls), wyciaga z niego pierwszy prawdziwy adres."""
    try:
        gniazdo, strumien, naglowki = _polacz(url)
    except Exception as blad:
        return {"ok": False, "powod": str(blad), "poprawiony": None}

    try:
        typ = (naglowki.get("content-type") or "").lower()

        # Plik playlisty - wyciagamy z niego adres strumienia
        if "mpegurl" in typ or "scpls" in typ or "x-scpls" in typ or url.lower().endswith((".m3u", ".pls", ".m3u8")):
            tresc = strumien.read(4096).decode("utf-8", "replace")
            for linia in tresc.splitlines():
                linia = linia.strip()
                if linia.lower().startswith("file"):
                    linia = linia.split("=", 1)[-1].strip()
                if linia.startswith("http"):
                    wynik = sprawdz_stacje(linia)
                    wynik["poprawiony"] = linia if wynik["ok"] else None
                    return wynik
            return {"ok": False, "powod": "playlista bez adresu", "poprawiony": None}

        if "audio" in typ or "ogg" in typ or naglowki.get("icy-metaint") or naglowki.get("icy-name"):
            return {"ok": True, "powod": None, "poprawiony": None}

        # Brak jasnego typu - sprawdzamy, czy w ogole cokolwiek plynie
        if strumien.read(1024):
            return {"ok": True, "powod": None, "poprawiony": None}
        return {"ok": False, "powod": "brak danych", "poprawiony": None}
    except Exception as blad:
        return {"ok": False, "powod": str(blad), "poprawiony": None}
    finally:
        try:
            strumien.close()
            gniazdo.close()
        except Exception:
            pass


def tytul_z_cache(url):
    teraz = time.time()
    with _cache_lock:
        wpis = _cache.get(url)
        if wpis and teraz - wpis[0] < CACHE_SEKUND:
            return wpis[1]
    try:
        wynik = pobierz_tytul(url)
    except Exception as blad:
        wynik = {"tytul": None, "stacja": None, "powod": "blad polaczenia: %s" % blad}
    with _cache_lock:
        _cache[url] = (teraz, wynik)
    return wynik


class Uchwyt(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=KATALOG, **kwargs)

    def guess_type(self, sciezka):
        rozszerzenie = os.path.splitext(sciezka)[1].lower()
        if rozszerzenie in TYPY_MIME:
            return TYPY_MIME[rozszerzenie]
        return super().guess_type(sciezka)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        rozbite = urllib.parse.urlparse(self.path)
        if rozbite.path == "/api/utwor":
            parametry = urllib.parse.parse_qs(rozbite.query)
            adres = (parametry.get("url") or [""])[0]
            if not adres.startswith("http"):
                self.odpowiedz_json({"tytul": None, "powod": "brak adresu"}, 400)
                return
            self.odpowiedz_json(tytul_z_cache(adres))
            return
        if rozbite.path == "/api/sprawdz":
            parametry = urllib.parse.parse_qs(rozbite.query)
            adres = (parametry.get("url") or [""])[0]
            if not adres.startswith("http"):
                self.odpowiedz_json({"ok": False, "powod": "brak adresu"}, 400)
                return
            self.odpowiedz_json(sprawdz_stacje(adres))
            return
        if rozbite.path == "/api/szukaj":
            parametry = urllib.parse.parse_qs(rozbite.query)
            fraza = (parametry.get("q") or [""])[0].strip()
            kraj = (parametry.get("kraj") or [""])[0].strip().upper()[:2]
            if fraza and len(fraza) < 2:
                self.odpowiedz_json({"ok": False, "powod": "podaj co najmniej dwa znaki", "wyniki": []})
                return
            self.odpowiedz_json(szukaj_w_bazie(fraza, kraj=kraj))
            return
        if rozbite.path == "/api/moje":
            self.odpowiedz_json(wczytaj_moje_stacje())
            return
        if rozbite.path == "/api/status":
            self.odpowiedz_json({"ok": True})
            return
        if rozbite.path == "/api/wersja":
            self.odpowiedz_json({"app": "radio-rock", "wersja": "7.2"})
            return
        if rozbite.path == "/api/strumien":
            parametry = urllib.parse.parse_qs(rozbite.query)
            adres = (parametry.get("url") or [""])[0]
            if not adres.startswith("http"):
                self.send_error(400)
                return
            self.przekaz_strumien(adres)
            return
        super().do_GET()

    def do_POST(self):
        rozbite = urllib.parse.urlparse(self.path)
        if rozbite.path != "/api/moje":
            self.send_error(404)
            return

        dlugosc = int(self.headers.get("Content-Length") or 0)
        if dlugosc > 200000:
            self.odpowiedz_json({"ok": False, "powod": "za duzo danych"}, 400)
            return

        try:
            dane = json.loads(self.rfile.read(dlugosc).decode("utf-8"))
            if isinstance(dane, list):
                dane = {"moje": dane, "ukryte": []}
            if not isinstance(dane, dict):
                raise ValueError("oczekiwano danych katalogu")

            surowe_moje = dane.get("moje") if isinstance(dane.get("moje"), list) else []
            surowe_ukryte = dane.get("ukryte") if isinstance(dane.get("ukryte"), list) else []

            czyste = []
            for pozycja in surowe_moje[:300]:
                if not isinstance(pozycja, dict):
                    continue
                adres = str(pozycja.get("url", "")).strip()
                nazwa = str(pozycja.get("nazwa", "")).strip()[:60]
                kategoria = str(pozycja.get("kategoria", "tematyczne")).strip()
                if not nazwa or not adres.lower().startswith(("http://", "https://")):
                    continue
                if kategoria not in ("rock", "ogolne", "tematyczne"):
                    kategoria = "tematyczne"
                czyste.append({"nazwa": nazwa, "url": adres, "kategoria": kategoria})

            ukryte = [str(u).strip() for u in surowe_ukryte[:500]
                      if str(u).strip().lower().startswith(("http://", "https://"))]

            zapisz_moje_stacje({"moje": czyste, "ukryte": ukryte})
            self.odpowiedz_json({"ok": True, "zapisane": len(czyste), "ukryte": len(ukryte)})
        except Exception as blad:
            self.odpowiedz_json({"ok": False, "powod": str(blad)}, 400)

    def przekaz_strumien(self, adres):
        """Posrednik miedzy AVPlayerem (natywna appka Mac) a stacja radiowa.
        AVPlayer nie rozumie ICY (metadane wplecione w bajty audio, status
        "ICY 200 OK" zamiast HTTP), a Python juz to potrafi (patrz _polacz) -
        wiec appka laczy sie zawsze tutaj, nigdy bezposrednio ze stacja."""
        try:
            gniazdo, strumien, naglowki = _polacz(adres, icy_metadata=False)
        except Exception:
            try:
                self.send_error(502)
            except Exception:
                pass
            return

        # WAZNE: socket.create_connection() w _polacz() ustawia limit 8s na
        # NAWIAZANIE polaczenia, ale ten limit zostaje aktywny takze na kazdym
        # kolejnym odczycie z gniazda - wlacznie z ta petla, ktora trwa tak
        # dlugo jak samo sluchanie radia. Zwykla, normalna przerwa w nadawaniu
        # ze stacji dluzsza niz 8s (typowa dla zywego strumienia) powodowala
        # cichy timeout i zerwanie calego przekazywania bez zadnego bledu -
        # dokladnie objaw "gra kilkanascie-kilkadziesiat sekund i nagle na
        # zawsze cichnie". Ten sam blad (za krotki limit) zlapalismy juz w
        # wersji androidowej (6.6/7.2, limit podniesiony z 5 do 12s). Tutaj:
        # po udanym polaczeniu zdejmujemy krotki limit na czas trwania
        # strumieniowania. Potwierdzone testem: bez tej linii strumien urywa
        # sie dokladnie po 8s przerwy w nadawaniu, z nia - nie.
        try:
            gniazdo.settimeout(20)
        except Exception:
            pass

        try:
            typ = naglowki.get("content-type") or "audio/mpeg"
            self.send_response(200)
            self.send_header("Content-Type", typ)
            self.end_headers()

            metaint_naglowek = naglowki.get("icy-metaint")
            metaint = int(metaint_naglowek) if metaint_naglowek and metaint_naglowek.isdigit() else 0

            while True:
                if metaint > 0:
                    pozostalo = metaint
                    while pozostalo > 0:
                        porcja = strumien.read(min(8192, pozostalo))
                        if not porcja:
                            return
                        pozostalo -= len(porcja)
                        self.wfile.write(porcja)
                    bajt_dlugosci = strumien.read(1)
                    if not bajt_dlugosci:
                        return
                    dlugosc = bajt_dlugosci[0] * 16
                    pozostalo_metadanych = dlugosc
                    while pozostalo_metadanych > 0:
                        porcja = strumien.read(min(4096, pozostalo_metadanych))
                        if not porcja:
                            return
                        pozostalo_metadanych -= len(porcja)
                    # metadane celowo pomijane - AVPlayer dostaje czysty dzwiek,
                    # tytul appka pobiera osobno przez /api/utwor
                else:
                    porcja = strumien.read(8192)
                    if not porcja:
                        return
                    self.wfile.write(porcja)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception:
            pass
        finally:
            try:
                strumien.close()
                gniazdo.close()
            except Exception:
                pass

    def odpowiedz_json(self, dane, kod=200):
        tresc = json.dumps(dane, ensure_ascii=False).encode("utf-8")
        self.send_response(kod)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(tresc)))
        self.end_headers()
        self.wfile.write(tresc)

    def log_message(self, format, *args):
        pass  # cisza w oknie terminala


class Serwer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    if not os.path.isdir(KATALOG):
        print("Nie znaleziono katalogu www obok serwer.py")
        sys.exit(1)

    port = PORT
    for proba in range(10):
        try:
            serwer = Serwer(("127.0.0.1", port), Uchwyt)
            break
        except OSError:
            port += 1
    else:
        print("Nie udalo sie zajac zadnego portu w zakresie %d-%d" % (PORT, PORT + 9))
        sys.exit(1)

    adres = "http://127.0.0.1:%d/" % port
    print("")
    print("  RADIO ROCK dziala pod adresem: %s" % adres)
    if PRZEGLADARKA != "domyslna":
        print("  Przegladarka: %s" % PRZEGLADARKA)
    print("  Wlasne stacje: %s" % PLIK_MOICH_STACJI)
    print("  Zamkniecie tego okna wylacza radio.")
    print("")
    threading.Timer(1.0, lambda: otworz_okno(adres)).start()
    try:
        serwer.serve_forever()
    except KeyboardInterrupt:
        print("Zatrzymano.")


if __name__ == "__main__":
    main()
