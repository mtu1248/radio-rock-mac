#!/bin/bash
# Radio Rock (Mac 8.5) — instalacja. Usuwa poprzednia wersje i wgrywa nowa.

KATALOG="$(cd "$(dirname "$0")" && pwd)"
CEL="/Applications/Radio Rock.app"
ZRODLO="$KATALOG/Radio Rock.app"

clear
echo ""
echo "  ── INSTALACJA RADIO ROCK 8.5 (Mac) ───────────────────"
echo ""

if [ ! -d "$ZRODLO" ]; then
  echo "  Nie znaleziono \"Radio Rock.app\" obok tego pliku."
  echo "  Rozpakuj cala paczke i uruchom ponownie."
  echo ""
  read -r -p "  Nacisnij Enter, aby zamknac..."
  exit 1
fi

echo "  1/5  Zatrzymuje dzialajace radio..."
pkill -f "Radio Rock.app/Contents/Resources/serwer.py" 2>/dev/null
osascript -e 'tell application "Radio Rock" to quit' 2>/dev/null
sleep 1

if [ -d "$CEL" ]; then
  echo "  2/5  Usuwam poprzednia wersje..."
  rm -rf "$CEL"
else
  echo "  2/5  Poprzedniej wersji nie ma — instaluje od zera."
fi

echo "  3/5  Wgrywam nowa wersje do Programow..."
cp -R "$ZRODLO" "$CEL" || { echo "  Nie udalo sie skopiowac."; read -r -p "  Enter..."; exit 1; }

echo "  4/5  Ustawiam uprawnienia i podpis..."
chmod +x "$CEL/Contents/MacOS/RadioRockMac"
if command -v iconutil >/dev/null 2>&1 && [ -d "$CEL/Contents/Resources/ikona.iconset" ]; then
  iconutil -c icns "$CEL/Contents/Resources/ikona.iconset" \
           -o "$CEL/Contents/Resources/AppIcon.icns" 2>/dev/null
fi
xattr -dr com.apple.quarantine "$CEL" 2>/dev/null
codesign --force --deep --sign - "$CEL" 2>/dev/null
touch "$CEL"

echo "  5/5  Czyszcze duchy w Launchpadzie i odswiezam..."
# Sama podmiana bundla w /Applications (krok 2) nie usuwa starych wpisow z
# bazy LaunchServices - po kilku instalacjach ad-hoc-podpisanej appki
# Launchpad potrafi pokazywac 2-3 ikony tej samej appki, mimo ze na dysku
# jest tylko jeden "Radio Rock.app" (sprawdzone: ls /Applications). To duchy
# w bazie LaunchServices, nie duplikaty plikow - trzeba ja w calosci
# przebudowac, samo "-f" na jeden bundle tego nie czysci.
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
"$LSREGISTER" -kill -r -domain local -domain user 2>/dev/null
"$LSREGISTER" -f "$CEL" 2>/dev/null
killall Dock 2>/dev/null
killall Launchpad 2>/dev/null

echo ""
echo "  ── GOTOWE ────────────────────────────────────────────"
echo ""
echo "  Radio Rock jest w Programach. Dziala jako ikonka w pasku"
echo "  menu (gora ekranu) — nie w Docku. Zamkniecie okna nie"
echo "  wylacza radia, tylko chowa okno."
echo ""
echo "  Wyjscie audio: ikonka w pasku menu -> Wyjscie audio,"
echo "  albo panel \"Wyglad\" w samej aplikacji."
echo ""
echo "  Wymaga python3 zainstalowanego na tym Macu (tak jak"
echo "  poprzednie wersje 6.x/7.x)."
echo ""
read -r -p "  Nacisnij Enter, aby otworzyc radio..."
open "$CEL"
