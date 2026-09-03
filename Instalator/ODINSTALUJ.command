#!/bin/bash
# Radio Rock (Mac 8.6) — odinstalowanie.

clear
echo ""
echo "  ── ODINSTALOWANIE RADIO ROCK ─────────────────────────"
echo ""

echo "  Zatrzymuje aplikacje..."
osascript -e 'tell application "Radio Rock" to quit' 2>/dev/null
pkill -f "Radio Rock.app/Contents/Resources/serwer.py" 2>/dev/null
sleep 1

if [ -d "/Applications/Radio Rock.app" ]; then
  rm -rf "/Applications/Radio Rock.app"
  echo "  Usunieto z Programow."
else
  echo "  Nie znaleziono w Programach — nic do usuniecia."
fi

killall Dock 2>/dev/null

echo ""
echo "  Wlasne stacje i ustawienia (jesli sa) zostaly w:"
echo "  ~/Library/Application Support/Radio Rock/"
echo "  Usun ten folder recznie, jesli chcesz wyczyscic wszystko."
echo ""
read -r -p "  Nacisnij Enter, aby zamknac..."
