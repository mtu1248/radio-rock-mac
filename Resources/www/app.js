/* ==================================================================
   Radio Rock - logika aplikacji
   ================================================================== */

const KLUCZ_LISTY   = 'radio_rock_listy_v2';
const KLUCZ_USTAW   = 'radio_rock_ustawienia_v2';
const KLUCZ_MOJE    = 'radio_rock_moje_stacje_v1';
const KLUCZ_OSTATNIA = 'radio_rock_ostatnia_v1';
const MAKS_STACJI   = 12;

const SKORKI = [
  { id: 'auto',     nazwa: 'Auto' },
  { id: 'tuner',    nazwa: 'Tuner' },
  { id: 'kokpit',   nazwa: 'Kokpit' },
  { id: 'kaseta',   nazwa: 'Kaseta' },
  { id: 'kafle',    nazwa: 'Kafle' },
  { id: 'telefon',  nazwa: 'Telefon' }
];

const PALETY = [
  { id: 'stal',     nazwa: 'Stal',     probka: '#c6ccd4' },
  { id: 'bursztyn', nazwa: 'Bursztyn', probka: '#ffb43c' },
  { id: 'granat',   nazwa: 'Granat',   probka: '#2f6fa8' },
  { id: 'czern',    nazwa: 'Czern',    probka: '#b8362b' },
  { id: 'papier',   nazwa: 'Papier',   probka: '#e8dfcc' }
];

// paleta, ktora najlepiej pasuje do danej skorki przy pierwszym wlaczeniu
const DOMYSLNE_PALETY = {
  auto: 'czern', tuner: 'stal', kokpit: 'bursztyn',
  kaseta: 'bursztyn', kafle: 'granat', telefon: 'czern'
};

/* --- stan --- */

let listy = [];
let indeksListy = 0;
let idBiezacej = null;
let idEdytowanej = null;
let kategoriaKatalogu = 'rock';
let timerUtworu = null;
let stanStacji = {};   // url -> 'dziala' | 'padla' | 'testowana'
let wybranePalety = {}; // skorka -> wybrana paleta
let przenoszenie = null;
let blokujKlik = false;
let trybEdycji = false;
let mojeStacje = [];      // stacje dodane przez uzytkownika, na stale w katalogu
let ukryteStacje = [];    // adresy pozycji wbudowanych usunietych z katalogu
let trybKatalogu = false; // edycja katalogu: usuwanie i poprawianie pozycji
let wynikiSieci = [];     // wyniki wyszukiwarki Radio Browser
let timerSzukania = null;
let krajSieci = 'PL';      // '' = caly swiat
let trybSerwera = false;   // czy dziala lokalny serwer (Mac) czy sama strona (iPhone/iPad)
const POD_HTTPS = location.protocol === 'https:';

// Lustra bazy Radio Browser - uzywane bezposrednio, gdy nie ma lokalnego serwera
const LUSTRA_BAZY = [
  'https://de1.api.radio-browser.info',
  'https://nl1.api.radio-browser.info',
  'https://at1.api.radio-browser.info'
];

const el = id => document.getElementById(id);
const audio = el('odtwarzacz');


/* ==================================================================
   Warstwa odtwarzania.
   W przeglądarce gra element <audio>. W aplikacji na Androida gra
   ExoPlayer po stronie systemu — dzięki temu dźwięk nie milknie przy
   zgaszonym ekranie, działają przyciski z kierownicy i widać tytuł
   granego utworu. Reszta kodu nie musi wiedzieć, który silnik działa.
   ================================================================== */

const most = (typeof window.Android !== 'undefined' && window.Android) ? window.Android : null;
let graNatywnie = false;
let wyciszoneNatywnie = false;

const czyGra   = () => most ? graNatywnie : !audio.paused;
const czyCisza = () => most ? wyciszoneNatywnie : audio.muted;

function odtwarzajListe(stacja) {
  const lista = aktywnaLista();
  const indeks = lista.stacje.findIndex(s => s.id === stacja.id);
  try { localStorage.setItem(KLUCZ_OSTATNIA, JSON.stringify({ lista: indeksListy, stacja: indeks })); } catch (e) {}
  if (most) {
    // przekazujemy całą listę, żeby przyciski "następna/poprzednia"
    // z kierownicy i z ekranu blokady działały bez udziału tej strony
    most.ustawListe(JSON.stringify(lista.stacje.map(s => ({ nazwa: s.nazwa, url: s.url }))), indeks);
  } else {
    audio.src = adresDoOdtwarzania(stacja.url);
    audio.load();
    audio.play().catch(pokazBlad);
  }
}

function ustawGlosnoscSilnika(wartosc) {
  if (most) most.glosnosc(wartosc);
  else audio.volume = wartosc;
}

function ustawWyciszenieSilnika(czy) {
  if (most) { wyciszoneNatywnie = czy; most.wycisz(czy); }
  else audio.muted = czy;
}

/* --- sygnały przychodzące z aplikacji androidowej --- */

window.zNatywnego_stan = function (gra) {
  graNatywnie = !!gra;
  odswiezWyswietlacz();
  ustawWskazniki();
};

window.zNatywnego_stacja = function (indeks) {
  const lista = aktywnaLista();
  const stacja = lista.stacje[indeks];
  if (!stacja) return;
  idBiezacej = stacja.id;
  ustawUtwor('');
  rysujKafelki();
  odswiezWyswietlacz();
};

window.zNatywnego_tytul = function (tytul) {
  ustawUtwor(tytul || '');
};

window.zNatywnego_blad = function () {
  graNatywnie = false;
  pokazBlad();
};

/* --- wybor wyjscia audio dzwieku - dotyczy tylko wersji na Maca.
   Android tez definiuje window.Android, wiec rozpoznajemy Maca po tym,
   ze jego mostek dodatkowo ma metode ustawUrzadzenie (Kotlin jej nie ma). --- */
const maWyjsciaAudio = !!(most && typeof most.ustawUrzadzenie === 'function');
if (maWyjsciaAudio) {
  el('tytulWyjsciaAudio').classList.remove('ukryty');
  el('wyjscieAudio').classList.remove('ukryty');
  el('wyjscieAudio').addEventListener('change', function () {
    most.ustawUrzadzenie(this.value);
  });
}

window.zNatywnego_urzadzenia = function (lista, aktualneUid) {
  if (!maWyjsciaAudio) return;
  const wybor = el('wyjscieAudio');
  wybor.innerHTML = '';
  const opcjaDomyslna = document.createElement('option');
  opcjaDomyslna.value = '';
  opcjaDomyslna.textContent = 'Domyślne wyjście systemu';
  wybor.appendChild(opcjaDomyslna);
  (lista || []).forEach(function (urzadzenie) {
    const opcja = document.createElement('option');
    opcja.value = urzadzenie.uid;
    opcja.textContent = urzadzenie.nazwa;
    wybor.appendChild(opcja);
  });
  wybor.value = aktualneUid || '';
};

window.zNatywnego_urzadzenie = function (uid) {
  if (!maWyjsciaAudio) return;
  el('wyjscieAudio').value = uid || '';
};

/* --- korektor dzwieku (rowniez tylko Mac) - jak wyzej: rozpoznajemy po tym,
   ze mostek ma metode ustawKorektor. 10 pasm, wartosci w dB, -12..+12.
   Presety to zwykle tablice liczb - appka macowa nic o nich nie wie, liczy
   sie tylko finalna tablica wyslana przez most.ustawKorektor(). --- */
const maKorektor = !!(most && typeof most.ustawKorektor === 'function');

const PASMA_KOREKTORA = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const PRESETY_KOREKTORA = {
  plaski:    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  rock:      [4, 3, -2, -3, -1, 2, 5, 6, 6, 5],
  pop:       [-1, 2, 4, 4, 2, -1, -2, -2, -1, -1],
  jazz:      [3, 2, 1, 2, -1, -1, 0, 1, 2, 3],
  klasyczna: [3, 2, 1, 0, 0, 0, -1, -1, -1, -2],
  basy:      [7, 6, 5, 3, 1, 0, 0, 0, 0, 0],
  wokal:     [-3, -3, -1, 2, 4, 4, 3, 1, -1, -2]
};

let wzmocnieniaKorektora = PRESETY_KOREKTORA.plaski.slice();
let suwakiKorektora = [];
let etykietyKorektora = [];

function etykietaDb(db) { return (db > 0 ? '+' : '') + db; }

function rysujKorektor() {
  if (!maKorektor) return;
  el('tytulKorektor').classList.remove('ukryty');
  el('korektor').classList.remove('ukryty');
  if (!suwakiKorektora.length) {
    const kontener = el('korektorSuwaki');
    PASMA_KOREKTORA.forEach(function (hz, i) {
      const kolumna = document.createElement('div');
      kolumna.className = 'korektor-pasmo';

      const wartosc = document.createElement('span');
      wartosc.className = 'korektor-db';
      wartosc.textContent = '0';

      const suwak = document.createElement('input');
      suwak.type = 'range';
      suwak.className = 'korektor-suwak';
      suwak.min = '-12';
      suwak.max = '12';
      suwak.step = '1';
      suwak.value = '0';
      suwak.setAttribute('aria-label', 'Korektor ' + hz + ' Hz');
      suwak.addEventListener('input', function () {
        const db = parseInt(this.value, 10);
        wzmocnieniaKorektora[i] = db;
        wartosc.textContent = etykietaDb(db);
        el('korektorPreset').value = 'wlasny';
        most.ustawKorektor(wzmocnieniaKorektora.slice());
      });

      const etykieta = document.createElement('span');
      etykieta.className = 'korektor-hz';
      etykieta.textContent = hz >= 1000 ? (hz / 1000) + 'k' : String(hz);

      kolumna.appendChild(wartosc);
      kolumna.appendChild(suwak);
      kolumna.appendChild(etykieta);
      kontener.appendChild(kolumna);
      suwakiKorektora.push(suwak);
      etykietyKorektora.push(wartosc);
    });

    el('korektorPreset').addEventListener('change', function () {
      const nazwa = this.value;
      if (nazwa === 'wlasny' || !PRESETY_KOREKTORA[nazwa]) return;
      wzmocnieniaKorektora = PRESETY_KOREKTORA[nazwa].slice();
      odswiezSuwakiKorektora();
      most.ustawKorektor(wzmocnieniaKorektora.slice());
    });
  }
  odswiezSuwakiKorektora();
}

function odswiezSuwakiKorektora() {
  wzmocnieniaKorektora.forEach(function (db, i) {
    if (suwakiKorektora[i]) suwakiKorektora[i].value = db;
    if (etykietyKorektora[i]) etykietyKorektora[i].textContent = etykietaDb(db);
  });
  const dopasowany = Object.keys(PRESETY_KOREKTORA).find(function (nazwa) {
    return PRESETY_KOREKTORA[nazwa].every(function (v, i) { return v === wzmocnieniaKorektora[i]; });
  });
  const wybor = el('korektorPreset');
  if (wybor) wybor.value = dopasowany || 'wlasny';
}

window.zNatywnego_korektor = function (pasma) {
  if (!maKorektor || !Array.isArray(pasma) || pasma.length !== PASMA_KOREKTORA.length) return;
  wzmocnieniaKorektora = pasma.map(function (v) { return Math.round(v); });
  if (suwakiKorektora.length) odswiezSuwakiKorektora();
};

/* ==================================================================
   Skalowanie do dostępnego miejsca.
   Panel samochodowy raz pokazuje aplikację na pełnym ekranie, raz
   w okienku. Zamiast zostawiać puste marginesy, mierzymy interfejs
   przy stałej szerokości i powiększamy albo pomniejszamy całość tak,
   żeby wypełniła to, co jest.
   ================================================================== */

const SZEROKOSCI_BAZOWE = [640, 720, 800, 900, 1000, 1120, 1260];   // px — próbowane kolejno
const NAJWIEKSZE_POWIEKSZENIE = 4;

let timerSkali = null;

/**
 * Sama zmiana skali nie wystarcza: przy panelu 1024×600 interfejs
 * zaprojektowany na 1000 px wypełnia szerokość, ale zostawia pusty pas
 * na dole. Dlatego najpierw dobieramy szerokość, przy której układ ma
 * proporcje najbliższe ekranowi — węższa szerokość przepakowuje kafelki
 * i podnosi wysokość — a dopiero potem skalujemy.
 */
function dopasujSkale() {
  const obudowa = document.querySelector('.obudowa');
  if (!obudowa) return;

  const szerokoscOkna = window.innerWidth;
  const wysokoscOkna = window.innerHeight;

  // skórka Telefon jest z założenia płynna; tak samo wąskie, pionowe ekrany
  if (document.body.dataset.skorka === 'telefon' || szerokoscOkna / wysokoscOkna <= 1.15) {
    obudowa.style.width = '';
    obudowa.style.transform = '';
    obudowa.classList.remove('skalowana');
    return;
  }

  obudowa.classList.add('skalowana');
  const zapas = 16;   // margines na zaokrąglone rogi ekranu i cienie
  let najlepsza = null;

  for (const baza of SZEROKOSCI_BAZOWE) {
    obudowa.style.width = baza + 'px';
    obudowa.style.transform = 'translate(-50%, -50%) scale(1)';

    // Mierzymy to, co układ NAPRAWDĘ zajmuje — łącznie z elementami, które
    // wystają poza swój kontener. Liczenie po samej deklaracji kończyło się
    // ucinaniem prawej kolumny.
    const wysokosc = Math.max(obudowa.offsetHeight, obudowa.scrollHeight);
    const szerokosc = Math.max(obudowa.offsetWidth, obudowa.scrollWidth, baza, najdalszaKrawedz(obudowa));
    if (!wysokosc || !szerokosc) continue;

    const skala = Math.min(
      (szerokoscOkna - zapas) / szerokosc,
      (wysokoscOkna - zapas) / wysokosc,
      NAJWIEKSZE_POWIEKSZENIE
    );
    const zajetePole = szerokosc * skala * wysokosc * skala;

    if (!najlepsza || zajetePole > najlepsza.pole) {
      najlepsza = { baza, skala, pole: zajetePole };
    }
  }

  if (!najlepsza) return;
  obudowa.style.width = najlepsza.baza + 'px';
  obudowa.style.transform =
    'translate(-50%, -50%) scale(' + najlepsza.skala.toFixed(3) + ')';
}

/** Najdalsza prawa krawędź spośród wszystkich elementów w środku.
 *  scrollWidth bywa zaniżony, gdy dziecko wystaje poza rodzica
 *  z widoczną zawartością — wtedy dopiero to daje prawdziwą szerokość. */
function najdalszaKrawedz(pojemnik) {
  const podstawa = pojemnik.getBoundingClientRect().left;
  let najdalej = 0;
  pojemnik.querySelectorAll('*').forEach(element => {
    const prawa = element.getBoundingClientRect().right - podstawa;
    if (prawa > najdalej) najdalej = prawa;
  });
  return Math.ceil(najdalej);
}

function dopasujZOpoznieniem() {
  clearTimeout(timerSkali);
  timerSkali = setTimeout(dopasujSkale, 60);
}

window.addEventListener('resize', dopasujZOpoznieniem);
window.addEventListener('orientationchange', dopasujZOpoznieniem);

/* --- pomocnicze --- */

const nowyId = () => Math.random().toString(36).slice(2, 10);
const aktywnaLista = () => listy[indeksListy];
const biezacaStacja = () => (aktywnaLista() || { stacje: [] }).stacje.find(s => s.id === idBiezacej) || null;

/* --- zapis / odczyt --- */

function wczytaj() {
  try {
    const zapis = JSON.parse(localStorage.getItem(KLUCZ_LISTY));
    if (Array.isArray(zapis) && zapis.length) { listy = zapis; return; }
  } catch (e) { /* pusty lub uszkodzony zapis */ }

  const wszystkie = KATALOG.flatMap(k => k.pozycje);
  listy = LISTY_STARTOWE.map(l => ({
    id: nowyId(),
    nazwa: l.nazwa,
    stacje: l.stacje
      .map(url => wszystkie.find(p => p.url === url))
      .filter(Boolean)
      .map(p => ({ id: nowyId(), nazwa: p.nazwa, url: p.url }))
  }));
  zapisz();
}

function zapisz() {
  try { localStorage.setItem(KLUCZ_LISTY, JSON.stringify(listy)); } catch (e) {}
}

function zapiszUstawienia() {
  try {
    localStorage.setItem(KLUCZ_USTAW, JSON.stringify({
      skorka: document.body.dataset.skorka,
      palety: wybranePalety,
      glosnosc: el('suwak').value,
      lista: indeksListy
    }));
  } catch (e) {}
}

/* --- zegar --- */

const DNI = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'];
const MIESIACE = ['stycznia','lutego','marca','kwietnia','maja','czerwca','lipca','sierpnia','września','października','listopada','grudnia'];

function odswiezZegar() {
  const t = new Date();
  const dwie = n => String(n).padStart(2, '0');
  el('zegar').textContent = dwie(t.getHours()) + ':' + dwie(t.getMinutes());
  el('data').textContent = DNI[t.getDay()] + ', ' + t.getDate() + ' ' + MIESIACE[t.getMonth()];
}

/* --- skorki --- */

function ustawSkorke(idSkorki) {
  document.body.dataset.skorka = idSkorki;
  const zapamietana = (wybranePalety || {})[idSkorki];
  document.body.dataset.paleta = zapamietana || DOMYSLNE_PALETY[idSkorki] || 'stal';
  rysujSkorki();
  rysujPalety();
  zapiszUstawienia();
}

function ustawPalete(idPalety) {
  document.body.dataset.paleta = idPalety;
  wybranePalety[document.body.dataset.skorka] = idPalety;
  rysujPalety();
  zapiszUstawienia();
}

function rysujSkorki() {
  const pojemnik = el('skorki');
  pojemnik.innerHTML = '';
  SKORKI.forEach(sk => {
    const guzik = document.createElement('button');
    guzik.className = 'probka' + (document.body.dataset.skorka === sk.id ? ' wybrana' : '');
    guzik.textContent = sk.nazwa;
    guzik.title = 'Skórka: ' + sk.nazwa;
    guzik.addEventListener('click', () => { ustawSkorke(sk.id); dopasujZOpoznieniem(); });
    pojemnik.appendChild(guzik);
  });
}

function rysujPalety() {
  const pojemnik = el('palety');
  pojemnik.innerHTML = '';
  PALETY.forEach(p => {
    const guzik = document.createElement('button');
    guzik.className = 'kropka' + (document.body.dataset.paleta === p.id ? ' wybrana' : '');
    guzik.style.background = p.probka;
    guzik.title = 'Kolory: ' + p.nazwa;
    guzik.setAttribute('aria-label', 'Kolory ' + p.nazwa);
    guzik.addEventListener('click', () => ustawPalete(p.id));
    pojemnik.appendChild(guzik);
  });
}

/* --- zakladki list --- */

function rysujZakladki() {
  const pojemnik = el('zakladki');
  pojemnik.innerHTML = '';
  listy.forEach((lista, i) => {
    const guzik = document.createElement('button');
    guzik.className = 'zakladka' + (i === indeksListy ? ' wybrana' : '');
    guzik.textContent = lista.nazwa;
    guzik.addEventListener('click', () => {
      indeksListy = i;
      if (trybEdycji) przelaczTrybEdycji();
      zapiszUstawienia();
      rysujZakladki();
      rysujKafelki();
      if (!el('panelKatalog').classList.contains('ukryty')) rysujKatalog();
    });
    pojemnik.appendChild(guzik);
  });

  const plus = document.createElement('button');
  plus.className = 'zakladka zakladka-plus';
  plus.textContent = '+';
  plus.title = 'Nowa lista';
  plus.addEventListener('click', nowaLista);
  pojemnik.appendChild(plus);
}

function nowaLista() {
  const nazwa = prompt('Nazwa nowej listy:', 'Lista ' + (listy.length + 1));
  if (!nazwa) return;
  listy.push({ id: nowyId(), nazwa: nazwa.trim().slice(0, 20), stacje: [] });
  indeksListy = listy.length - 1;
  zapisz(); zapiszUstawienia();
  rysujZakladki(); rysujKafelki();
  otworzKatalog();
}

function zmienNazweListy() {
  const lista = aktywnaLista();
  if (!lista) return;
  const nazwa = prompt('Nowa nazwa listy:', lista.nazwa);
  if (!nazwa) return;
  lista.nazwa = nazwa.trim().slice(0, 20);
  zapisz(); rysujZakladki();
}

function usunListe() {
  if (listy.length <= 1) { alert('To jedyna lista — nie można jej usunąć.'); return; }
  if (!confirm('Usunąć listę "' + aktywnaLista().nazwa + '"?')) return;
  listy.splice(indeksListy, 1);
  indeksListy = Math.max(0, indeksListy - 1);
  zapisz(); zapiszUstawienia();
  rysujZakladki(); rysujKafelki();
}

/* --- kafelki --- */

function rysujKafelki() {
  const pojemnik = el('kafelki');
  pojemnik.innerHTML = '';
  const lista = aktywnaLista();
  if (!lista) return;

  lista.stacje.forEach((stacja, i) => {
    const kafel = document.createElement('button');
    kafel.className = 'kafel' + (stacja.id === idBiezacej ? ' gra' : '');
    kafel.title = stacja.nazwa;

    if (POD_HTTPS && !trybSerwera && stacja.url.toLowerCase().startsWith('http://')) {
      kafel.classList.add('niedostepna');
      kafel.title = stacja.nazwa + ' — nadaje po zwykłym http; w tej wersji próbuję przez https, ale nie każdy nadawca to obsługuje';
    }

    const stan = stanStacji[stacja.url];
    if (stan) {
      const kropka = document.createElement('span');
      kropka.className = 'stan-stacji ' + stan;
      kropka.title = stan === 'dziala' ? 'Stacja odpowiada' : stan === 'padla' ? 'Stacja nie odpowiada' : 'Sprawdzanie…';
      kafel.appendChild(kropka);
    }

    const olowek = document.createElement('span');
    olowek.className = 'olowek';
    olowek.setAttribute('role', 'button');
    olowek.setAttribute('tabindex', '0');
    olowek.setAttribute('aria-label', 'Edytuj ' + stacja.nazwa);
    olowek.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';
    olowek.addEventListener('click', e => { e.stopPropagation(); otworzFormularz(stacja); });
    olowek.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); otworzFormularz(stacja); }
    });

    const cyfra = document.createElement('span');
    cyfra.className = 'cyfra';
    cyfra.textContent = String(i + 1);

    const nazwa = document.createElement('span');
    nazwa.className = 'nazwa-kafla';
    nazwa.textContent = stacja.nazwa;

    kafel.append(olowek, cyfra, nazwa);
    kafel.dataset.indeks = String(i);

    if (trybEdycji) {
      kafel.append(
        strzalkaPrzesuwania('lewo',  i, i > 0),
        strzalkaPrzesuwania('prawo', i, i < lista.stacje.length - 1)
      );
    }

    kafel.addEventListener('click', () => {
      if (blokujKlik || trybEdycji) return;
      wlacz(stacja);
    });
    podepnijPrzenoszenie(kafel, i);
    pojemnik.appendChild(kafel);
  });

  dopasujZOpoznieniem();

  for (let i = lista.stacje.length; i < MAKS_STACJI; i++) {
    const pusty = document.createElement('button');
    pusty.className = 'kafel pusty';
    pusty.dataset.indeks = 'koniec';
    pusty.textContent = '+';
    pusty.title = 'Dodaj stację z katalogu';
    pusty.addEventListener('click', otworzKatalog);
    pojemnik.appendChild(pusty);
  }
}


/* --- tryb ustawiania kolejnosci --- */

function strzalkaPrzesuwania(strona, indeks, wlaczona) {
  const guzik = document.createElement('span');
  guzik.className = 'przesun ' + strona + (wlaczona ? '' : ' nieczynna');
  guzik.setAttribute('role', 'button');
  guzik.setAttribute('tabindex', wlaczona ? '0' : '-1');
  guzik.setAttribute('aria-label', strona === 'lewo' ? 'Przesuń wcześniej' : 'Przesuń później');
  guzik.textContent = strona === 'lewo' ? '\u25C0' : '\u25B6';
  if (!wlaczona) return guzik;

  const przesun = zdarzenie => {
    zdarzenie.stopPropagation();
    przeniesStacje(indeks, strona === 'lewo' ? indeks - 1 : indeks + 1);
  };
  guzik.addEventListener('click', przesun);
  guzik.addEventListener('pointerdown', z => z.stopPropagation());
  guzik.addEventListener('keydown', z => { if (z.key === 'Enter' || z.key === ' ') przesun(z); });
  return guzik;
}

function przelaczTrybEdycji() {
  trybEdycji = !trybEdycji;
  document.body.classList.toggle('tryb-edycji', trybEdycji);
  el('btnKolejnosc').textContent = trybEdycji ? 'Gotowe' : 'Kolejność';
  el('btnKolejnosc').classList.toggle('wlaczona', trybEdycji);
  el('stopka').textContent = trybEdycji
    ? 'Przeciągnij kafelek albo użyj strzałek, żeby ustawić kolejność · Gotowe kończy edycję'
    : 'Klawisze 1-9 wybierają stację · strzałki przełączają · spacja pauzuje · M wycisza';
  rysujKafelki();
}

/* --- przestawianie kafelkow przytrzymaniem i przeciagnieciem --- */

const PROG_PRZYTRZYMANIA = 280;   // ms - dluzej niz zwykle tapniecie
const PROG_RUCHU = 10;            // px - powyzej tego to juz przewijanie, nie przytrzymanie

function podepnijPrzenoszenie(kafel, indeks) {
  kafel.addEventListener('pointerdown', zdarzenie => {
    if (zdarzenie.target.closest('.olowek') || zdarzenie.target.closest('.przesun')) return;
    if (zdarzenie.button !== undefined && zdarzenie.button !== 0) return;

    const prostokat = kafel.getBoundingClientRect();
    przenoszenie = {
      kafel, indeks,
      startX: zdarzenie.clientX, startY: zdarzenie.clientY,
      szerokosc: prostokat.width, wysokosc: prostokat.height,
      aktywne: false,
      timer: setTimeout(() => rozpocznijPrzenoszenie(), trybEdycji ? 0 : PROG_PRZYTRZYMANIA)
    };
    kafel.setPointerCapture(zdarzenie.pointerId);
  });

  kafel.addEventListener('pointermove', zdarzenie => {
    if (!przenoszenie || przenoszenie.kafel !== kafel) return;
    const dx = zdarzenie.clientX - przenoszenie.startX;
    const dy = zdarzenie.clientY - przenoszenie.startY;

    if (!przenoszenie.aktywne) {
      // ruch przed uplywem przytrzymania = przewijanie, nie przenoszenie
      if (Math.hypot(dx, dy) > PROG_RUCHU) {
        clearTimeout(przenoszenie.timer);
        przenoszenie = null;
      }
      return;
    }

    zdarzenie.preventDefault();
    kafel.style.transform = 'translate(' + dx + 'px, ' + dy + 'px)';
    oznaczCel(zdarzenie.clientX, zdarzenie.clientY);
  });

  const zakoncz = zdarzenie => {
    if (!przenoszenie || przenoszenie.kafel !== kafel) return;
    clearTimeout(przenoszenie.timer);

    if (przenoszenie.aktywne) {
      const cel = znajdzCel(zdarzenie.clientX, zdarzenie.clientY);
      posprzatajPrzenoszenie();
      if (cel !== null && cel !== przenoszenie.indeks) {
        przeniesStacje(przenoszenie.indeks, cel);
      }
      blokujKlik = true;
      setTimeout(() => { blokujKlik = false; }, 0);
    }
    przenoszenie = null;
  };

  kafel.addEventListener('pointerup', zakoncz);
  kafel.addEventListener('pointercancel', zakoncz);
}

function rozpocznijPrzenoszenie() {
  if (!przenoszenie) return;
  przenoszenie.aktywne = true;
  przenoszenie.kafel.classList.add('przenoszony');
  document.body.classList.add('przenoszenie');
  if (navigator.vibrate) navigator.vibrate(15);   // na telefonie sygnal, ze chwycilo
}

function znajdzCel(x, y) {
  if (!przenoszenie) return null;
  przenoszenie.kafel.style.pointerEvents = 'none';
  const pod = document.elementFromPoint(x, y);
  przenoszenie.kafel.style.pointerEvents = '';
  const kafel = pod && pod.closest ? pod.closest('.kafel') : null;
  if (!kafel || !kafel.dataset.indeks) return null;
  if (kafel.dataset.indeks === 'koniec') return aktywnaLista().stacje.length - 1;
  return Number(kafel.dataset.indeks);
}

function oznaczCel(x, y) {
  document.querySelectorAll('.cel-przenoszenia').forEach(k => k.classList.remove('cel-przenoszenia'));
  const cel = znajdzCel(x, y);
  if (cel === null || cel === przenoszenie.indeks) return;
  const kafel = document.querySelector('.kafel[data-indeks="' + cel + '"]');
  if (kafel) kafel.classList.add('cel-przenoszenia');
}

function posprzatajPrzenoszenie() {
  document.body.classList.remove('przenoszenie');
  document.querySelectorAll('.cel-przenoszenia').forEach(k => k.classList.remove('cel-przenoszenia'));
  if (!przenoszenie) return;
  przenoszenie.kafel.classList.remove('przenoszony');
  przenoszenie.kafel.style.transform = '';
}

function przeniesStacje(skad, dokad) {
  const stacje = aktywnaLista().stacje;
  const [przenoszona] = stacje.splice(skad, 1);
  stacje.splice(dokad, 0, przenoszona);
  zapisz();
  rysujKafelki();
  odswiezWyswietlacz();
}

/* --- wyswietlacz --- */

function odswiezWyswietlacz(tekst, klasa) {
  const lista = aktywnaLista() || { stacje: [] };
  const i = lista.stacje.findIndex(s => s.id === idBiezacej);
  el('numer').textContent = i === -1 ? '--' : String(i + 1);
  el('numer').classList.toggle('slaby', i === -1 || !czyGra());

  const nazwa = el('nazwa');
  nazwa.classList.remove('slaby', 'blad');
  if (tekst) {
    nazwa.textContent = tekst;
    if (klasa) nazwa.classList.add(klasa);
  } else if (i === -1) {
    nazwa.textContent = lista.stacje.length ? 'WYBIERZ STACJĘ' : 'DODAJ STACJE DO LISTY';
    nazwa.classList.add('slaby');
  } else {
    nazwa.textContent = lista.stacje[i].nazwa;
    if (!czyGra()) nazwa.classList.add('slaby');
  }
}

function ustawUtwor(tekst) {
  const pole = el('utwor');
  pole.classList.remove('przewijaj');
  pole.textContent = tekst || '\u00a0';
  requestAnimationFrame(() => {
    if (pole.scrollWidth > pole.parentElement.clientWidth + 4) pole.classList.add('przewijaj');
  });
}

function ustawWskazniki() {
  const gra = czyGra() && idBiezacej;
  el('dioda').classList.toggle('swieci', !!gra);
  el('slupki').classList.toggle('aktywne', !!gra);
  el('etykietaDiody').textContent = czyCisza() ? 'WYCISZONE' : gra ? 'NA ANTENIE' : 'GOTOWE';
  document.querySelector('.ikona-play').classList.toggle('ukryty', czyGra());
  document.querySelector('.ikona-pauza').classList.toggle('ukryty', !czyGra());
  document.querySelector('.ikona-glosnik').classList.toggle('ukryty', czyCisza());
  document.querySelector('.ikona-cisza').classList.toggle('ukryty', !czyCisza());
  el('btnWycisz').classList.toggle('wyciszony', czyCisza());
  el('btnPlay').disabled = !idBiezacej;
}

/* --- odtwarzanie --- */

function wlacz(stacja) {
  idBiezacej = stacja.id;
  ustawUtwor('');
  odtwarzajListe(stacja);
  rysujKafelki();
  odswiezWyswietlacz('ŁADOWANIE…', 'slaby');
  ustawMediaSession(stacja, '');
  uruchomPobieranieUtworu();
}

function przelacz(kierunek) {
  const lista = aktywnaLista();
  if (!lista || !lista.stacje.length) return;
  if (most && idBiezacej) { kierunek > 0 ? most.nastepna() : most.poprzednia(); return; }
  const teraz = lista.stacje.findIndex(s => s.id === idBiezacej);
  const nowy = teraz === -1
    ? (kierunek > 0 ? 0 : lista.stacje.length - 1)
    : (teraz + kierunek + lista.stacje.length) % lista.stacje.length;
  wlacz(lista.stacje[nowy]);
}

function przelaczOdtwarzanie() {
  if (!idBiezacej) return;
  if (most) { most.przelacz(); return; }
  if (audio.paused) audio.play().catch(pokazBlad);
  else audio.pause();
}

function pokazBlad() {
  odswiezWyswietlacz('BŁĄD STRUMIENIA', 'blad');
  const stacja = biezacaStacja();
  if (stacja) { stanStacji[stacja.url] = 'padla'; rysujKafelki(); }
  ustawUtwor('Stacja nie odpowiada — sprawdź adres ołówkiem');
  ustawWskazniki();
}

/* --- sterowanie z zewnatrz (kierownica, sluchawki, klawisze multimedialne) --- */

function ustawMediaSession(stacja, utwor) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: utwor || stacja.nazwa,
    artist: utwor ? stacja.nazwa : 'Radio Rock',
    album: (aktywnaLista() || {}).nazwa || ''
  });
  // Safari zglasza wyjatek przy nieobslugiwanej akcji - kazda osobno
  const akcje = {
    play: () => audio.play().catch(pokazBlad),
    pause: () => audio.pause(),
    previoustrack: () => przelacz(-1),
    nexttrack: () => przelacz(1)
  };
  Object.keys(akcje).forEach(nazwa => {
    try { navigator.mediaSession.setActionHandler(nazwa, akcje[nazwa]); } catch (e) {}
  });
}

/* --- tytul granego utworu --- */

function uruchomPobieranieUtworu() {
  clearInterval(timerUtworu);
  pobierzUtwor();
  timerUtworu = setInterval(pobierzUtwor, 15000);
}

async function pobierzUtwor() {
  if (most) return;   // w aplikacji tytuł przychodzi wprost z odtwarzacza
  const stacja = biezacaStacja();
  if (!stacja || !czyGra()) return;
  try {
    const odp = await fetch('/api/utwor?url=' + encodeURIComponent(stacja.url));
    if (!odp.ok) return;
    const dane = await odp.json();
    if (stacja.id !== idBiezacej) return;
    if (dane.tytul) {
      ustawUtwor(dane.tytul);
      ustawMediaSession(stacja, dane.tytul);
    } else if (!el('utwor').textContent.trim()) {
      ustawUtwor(dane.powod === 'stacja nie podaje tytulu' ? 'Ta stacja nie podaje tytułów' : '');
    }
  } catch (e) { /* aplikacja bez serwera - dziala, tylko bez tytulow */ }
}

/* --- test stacji --- */

async function sprawdzStacje(wTle) {
  const lista = aktywnaLista();
  if (!lista || !lista.stacje.length) return;
  const guzik = el('btnSprawdz');
  guzik.classList.add('pracuje');
  guzik.textContent = wTle ? 'Sprawdzam w tle…' : 'Sprawdzam…';

  lista.stacje.forEach(s => { stanStacji[s.url] = 'testowana'; });
  rysujKafelki();

  let dzialajace = 0;

  if (!trybSerwera) {
    // po cztery naraz, żeby test całej listy trwał sekundy, a nie minutę
    const paczki = [];
    for (let i = 0; i < lista.stacje.length; i += 4) paczki.push(lista.stacje.slice(i, i + 4));
    for (const paczka of paczki) {
      const wyniki = await Promise.all(paczka.map(st => sprawdzWPrzegladarce(st.url)));
      paczka.forEach((st, i) => {
        stanStacji[st.url] = wyniki[i] ? 'dziala' : 'padla';
        if (wyniki[i]) dzialajace++;
      });
      rysujKafelki();
    }
    guzik.classList.remove('pracuje');
    guzik.textContent = 'Sprawdź';
    el('stopka').textContent = 'Odpowiada ' + dzialajace + ' z ' + lista.stacje.length + ' stacji na tej liście';
    return;
  }

  for (const stacja of lista.stacje) {
    let dziala = false;
    if (trybSerwera) {
      try {
        const odp = await fetch('/api/sprawdz?url=' + encodeURIComponent(stacja.url));
        const dane = await odp.json();
        dziala = !!dane.ok;
        if (dane.poprawiony && dane.poprawiony !== stacja.url) {
          stacja.url = dane.poprawiony;   // adres wyciagniety z pliku playlisty
          zapisz();
        }
      } catch (e) { dziala = false; }
    } else {
      dziala = await sprawdzWPrzegladarce(stacja.url);
    }
    stanStacji[stacja.url] = dziala ? 'dziala' : 'padla';
    if (dziala) dzialajace++;
    rysujKafelki();
  }

  guzik.classList.remove('pracuje');
  guzik.textContent = 'Sprawdź';
  el('stopka').textContent = 'Odpowiada ' + dzialajace + ' z ' + lista.stacje.length + ' stacji na tej liście';
}

/* --- wlasne stacje dopisane do katalogu --- */

async function wczytajMojeStacje() {
  try {
    const odp = await fetch('/api/moje');
    if (odp.ok) {
      const dane = await odp.json();
      przyjmijKatalog(dane);
      try { localStorage.setItem(KLUCZ_MOJE, JSON.stringify(dane)); } catch (e) {}
      return;
    }
  } catch (e) { /* aplikacja bez serwera - zostaje kopia w przegladarce */ }
  try { przyjmijKatalog(JSON.parse(localStorage.getItem(KLUCZ_MOJE))); } catch (e) { przyjmijKatalog(null); }
}

function przyjmijKatalog(dane) {
  if (Array.isArray(dane)) { mojeStacje = dane; ukryteStacje = []; return; }   // starszy format
  if (dane && typeof dane === 'object') {
    mojeStacje = Array.isArray(dane.moje) ? dane.moje : [];
    ukryteStacje = Array.isArray(dane.ukryte) ? dane.ukryte : [];
    return;
  }
  mojeStacje = []; ukryteStacje = [];
}

async function zapiszMojeStacje() {
  const dane = { moje: mojeStacje, ukryte: ukryteStacje };
  try { localStorage.setItem(KLUCZ_MOJE, JSON.stringify(dane)); } catch (e) {}
  try {
    await fetch('/api/moje', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dane)
    });
  } catch (e) {
    el('stopka').textContent = 'Stacja zapisana tylko w tej przeglądarce — serwer nie odpowiedział';
  }
}

function pozycjeKategorii(idKategorii) {
  const wbudowane = (KATALOG.find(k => k.id === idKategorii) || KATALOG[0]).pozycje
    .filter(p => !ukryteStacje.includes(p.url));
  const wlasne = mojeStacje
    .filter(m => m.kategoria === idKategorii)
    .map(m => ({ nazwa: m.nazwa, url: m.url, wlasna: true }));
  return wbudowane.concat(wlasne);
}

function wszystkiePozycje() {
  return KATALOG.flatMap(k => k.pozycje).filter(p => !ukryteStacje.includes(p.url))
    .concat(mojeStacje.map(m => ({ nazwa: m.nazwa, url: m.url, wlasna: true })));
}


/** Na stronie po https przegladarka nie odtworzy strumienia po zwyklym http.
    Czesc nadawcow udostepnia ten sam strumien po https, wiec probujemy podmienic
    protokol - gorzej niz "nie zagra wcale" i tak nie bedzie. */
function adresDoOdtwarzania(url) {
  if (POD_HTTPS && !trybSerwera && url.toLowerCase().startsWith('http://')) {
    return 'https://' + url.slice(7);
  }
  return url;
}

/** Test stacji bez serwera: probujemy wczytac strumien odtwarzaczem.
    Na stronie po https adresy http sa z gory blokowane przez przegladarke. */
function sprawdzWPrzegladarce(url) {
  const adres = adresDoOdtwarzania(url);
  return new Promise(rozwiaz => {
    const probka = new Audio();
    let rozstrzygniete = false;
    const zakoncz = wynik => {
      if (rozstrzygniete) return;
      rozstrzygniete = true;
      probka.src = '';
      rozwiaz(wynik);
    };
    probka.preload = 'metadata';
    probka.muted = true;
    probka.addEventListener('loadedmetadata', () => zakoncz(true));
    probka.addEventListener('canplay', () => zakoncz(true));
    probka.addEventListener('error', () => zakoncz(false));
    probka.src = adres;
    probka.load();
    setTimeout(() => zakoncz(false), 7000);
  });
}

/* --- po uruchomieniu w samochodzie: graj sam i sprawdź listę --- */

/** Wraca do ostatnio granej stacji, a gdy takiej nie ma — do pierwszej
    z listy. Wywoływane tylko w aplikacji: w przeglądarce autoodtwarzanie
    i tak jest blokowane. */
function wznowOstatniaStacje() {
  if (!most) return;
  let zapis = null;
  try { zapis = JSON.parse(localStorage.getItem(KLUCZ_OSTATNIA)); } catch (e) {}

  if (zapis && listy[zapis.lista]) {
    indeksListy = zapis.lista;
    rysujZakladki();
    rysujKafelki();
  }
  const lista = aktywnaLista();
  if (!lista || !lista.stacje.length) return;

  const stacja = lista.stacje[(zapis && zapis.stacja) || 0] || lista.stacje[0];
  wlacz(stacja);
}

/** Test całej listy bez naciskania "Sprawdź" — po starcie i po każdym
    powrocie do aplikacji, ale nie częściej niż raz na pięć minut. */
let ostatnieSprawdzenie = 0;

function sprawdzSamoczynnie() {
  if (!most) return;
  const teraz = Date.now();
  if (teraz - ostatnieSprawdzenie < 5 * 60 * 1000) return;
  ostatnieSprawdzenie = teraz;
  setTimeout(() => sprawdzStacje(true), 4000);   // najpierw niech radio zagra
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  sprawdzSamoczynnie();
  dopasujSkale();
});

/* --- ratunek przy zerwanym połączeniu --- */

function komunikat(tekst) {
  el('stopka').textContent = tekst;
}

/** Podłączenie do stacji jeszcze raz. Najlżejszy z trzech przycisków. */
function odswiezPolaczenie() {
  if (most) {
    most.odswiez();
  } else if (biezacaStacja()) {
    audio.load();
    audio.play().catch(pokazBlad);
  }
  komunikat('Łączę się ze stacją jeszcze raz…');
}

/** Zerwanie i zbudowanie wszystkich połączeń od zera. */
function restartSieci() {
  if (most) {
    most.restartPolaczenia();
  } else {
    const stacja = biezacaStacja();
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    if (stacja) setTimeout(() => wlacz(stacja), 300);
  }
  stanStacji = {};
  rysujKafelki();
  komunikat('Buduję połączenia od nowa…');
}

/** Ostatnia deska ratunku: cała aplikacja od nowa. */
function restartAplikacji() {
  if (!confirm('Uruchomić aplikację od nowa? Muzyka na chwilę ucichnie.')) return;
  if (most) most.restartAplikacji();
  else location.reload();
}

/* --- katalog --- */

function otworzWyglad() {
  el('panelForm').classList.add('ukryty');
  el('panelKatalog').classList.add('ukryty');
  el('zaslona').classList.remove('ukryty');
  el('panelWyglad').classList.remove('ukryty');
  rysujSkorki();
  rysujPalety();
  rysujKorektor();
}

function otworzKatalog() {
  el('panelWyglad').classList.add('ukryty');
  el('panelForm').classList.add('ukryty');
  el('zaslona').classList.remove('ukryty');
  el('panelKatalog').classList.remove('ukryty');
  if (kategoriaKatalogu === 'internet') kategoriaKatalogu = 'rock';
  pokazInfo('');
  rysujKategorie();
  rysujKatalog();
}

function rysujKategorie() {
  const pojemnik = el('kategorie');
  pojemnik.innerHTML = '';

  const zakladki = KATALOG.map(k => ({ id: k.id, nazwa: k.nazwa }))
    .concat([{ id: 'internet', nazwa: 'Szukaj w sieci' }]);

  zakladki.forEach(kat => {
    const guzik = document.createElement('button');
    guzik.className = 'kategoria'
      + (kat.id === kategoriaKatalogu ? ' wybrana' : '')
      + (kat.id === 'internet' ? ' kategoria-sieciowa' : '');
    guzik.textContent = kat.nazwa;
    guzik.addEventListener('click', () => {
      kategoriaKatalogu = kat.id;
      el('szukaj').value = '';
      el('szukaj').placeholder = kat.id === 'internet'
        ? 'Wpisz nazwę stacji i naciśnij Enter…'
        : 'Szukaj stacji…';
      wynikiSieci = [];
      pokazInfo('');
      rysujKategorie();
      rysujKatalog();
      if (kat.id === 'internet') { szukajWSieci(''); el('szukaj').focus(); }
    });
    pojemnik.appendChild(guzik);
  });
}

function pokazInfo(tekst, rodzaj) {
  const pasek = el('paskInfo');
  pasek.textContent = tekst || '';
  pasek.className = 'pasek-info' + (rodzaj ? ' ' + rodzaj : '') + (tekst ? '' : ' ukryty');
}

/* --- wyszukiwarka stacji w internecie --- */

async function szukajWSieci(fraza) {
  const szukane = (fraza || '').trim();
  if (szukane && szukane.length < 2) { pokazInfo('Wpisz co najmniej dwa znaki.'); return; }

  // zakres (Polska / świat) obowiązuje tak samo przy liście domyślnej, jak i przy szukaniu
  const zapytanie = '/api/szukaj?q=' + encodeURIComponent(szukane) + '&kraj=' + krajSieci;

  pokazInfo(szukane
    ? 'Szukam „' + szukane + '”…'
    : 'Wczytuję listę najczęściej słuchanych stacji…');

  try {
    const dane = trybSerwera ? await przezSerwer(zapytanie) : await bezposrednioZBazy(szukane);
    if (!dane.ok) {
      wynikiSieci = [];
      pokazInfo('Baza stacji nie odpowiedziała. Sprawdź połączenie z internetem.', 'blad-info');
    } else if (!dane.wyniki.length) {
      wynikiSieci = [];
      pokazInfo(szukane
        ? 'Nic nie znaleziono dla „' + szukane + '”' + (krajSieci ? ' wśród polskich stacji — spróbuj przełączyć na Świat.' : '.')
        : 'Baza nic nie zwróciła.');
    } else {
      wynikiSieci = dane.wyniki;
      pokazInfo(szukane
        ? 'Znaleziono ' + dane.wyniki.length + ' stacji'
          + (krajSieci ? ' w Polsce' : ' na świecie') + ' — kliknij, żeby dodać do katalogu.'
        : dane.wyniki.length + ' najczęściej słuchanych stacji'
          + (krajSieci ? ' w Polsce' : ' na świecie')
          + ' — kliknij, żeby dodać, albo wpisz nazwę, żeby szukać.');
    }
  } catch (e) {
    wynikiSieci = [];
    pokazInfo('Nie udało się połączyć z bazą stacji. Sprawdź internet.', 'blad-info');
  }
  rysujKatalog();
}

async function przezSerwer(zapytanie) {
  const odp = await fetch(zapytanie);
  return odp.json();
}

/** Zapytanie prosto do Radio Browser - dziala bez lokalnego serwera,
    bo baza pozwala na zapytania z dowolnej strony. */
async function bezposrednioZBazy(szukane) {
  const parametry = new URLSearchParams({
    limit: '60', hidebroken: 'true', order: 'clickcount', reverse: 'true'
  });
  if (szukane) parametry.set('name', szukane);
  if (krajSieci) parametry.set('countrycode', krajSieci);

  let ostatniBlad = 'brak odpowiedzi';
  for (const lustro of LUSTRA_BAZY) {
    try {
      const odp = await fetch(lustro + '/json/stations/search?' + parametry.toString());
      if (!odp.ok) { ostatniBlad = 'kod ' + odp.status; continue; }
      const surowe = await odp.json();
      const widziane = new Set();
      const wyniki = [];
      surowe.forEach(st => {
        const adres = (st.url_resolved || st.url || '').trim();
        const nazwa = (st.name || '').trim().slice(0, 60);
        if (!nazwa || !/^https?:\/\//i.test(adres) || widziane.has(adres)) return;
        widziane.add(adres);
        wyniki.push({
          nazwa, url: adres,
          kraj: (st.country || '').trim().slice(0, 30),
          tagi: (st.tags || '').trim().slice(0, 60),
          kodek: (st.codec || '').trim().slice(0, 10),
          bitrate: st.bitrate || 0
        });
      });
      return { ok: true, powod: null, wyniki };
    } catch (e) { ostatniBlad = String(e); }
  }
  return { ok: false, powod: ostatniBlad, wyniki: [] };
}

function przelaczZakresSieci() {
  krajSieci = krajSieci ? '' : 'PL';
  el('btnZakresSieci').textContent = krajSieci ? 'Polska' : 'Świat';
  if (kategoriaKatalogu === 'internet') szukajWSieci(el('szukaj').value);
}

/* --- tryb edycji katalogu --- */

function przelaczTrybKatalogu() {
  trybKatalogu = !trybKatalogu;
  el('btnEdytujKatalog').textContent = trybKatalogu ? 'Zakończ edycję' : 'Edytuj katalog';
  el('btnEdytujKatalog').classList.toggle('wlaczona', trybKatalogu);
  rysujKatalog();
}

function usunZKataloguNaStale(pozycja) {
  if (pozycja.wlasna) {
    mojeStacje = mojeStacje.filter(m => m.url !== pozycja.url);
  } else if (!ukryteStacje.includes(pozycja.url)) {
    ukryteStacje.push(pozycja.url);
  }
  zapiszMojeStacje();
  rysujKatalog();
}

function przywrocUkryte(idKategorii) {
  const adresy = (KATALOG.find(k => k.id === idKategorii) || { pozycje: [] }).pozycje.map(p => p.url);
  ukryteStacje = ukryteStacje.filter(u => !adresy.includes(u));
  zapiszMojeStacje();
  rysujKatalog();
}

function edytujPozycjeKatalogu(pozycja) {
  const nazwa = prompt('Nazwa stacji:', pozycja.nazwa);
  if (nazwa === null) return;
  const url = prompt('Adres strumienia:', pozycja.url);
  if (url === null) return;
  if (!/^https?:\/\/.+/i.test(url.trim())) { alert('Adres musi zaczynać się od http:// lub https://'); return; }

  if (pozycja.wlasna) {
    const wpis = mojeStacje.find(m => m.url === pozycja.url);
    if (wpis) { wpis.nazwa = nazwa.trim().slice(0, 60); wpis.url = url.trim(); }
  } else {
    // pozycji wbudowanej nie da sie zmienic w miejscu - chowamy ja
    // i zapisujemy poprawiona wersje jako wlasna
    if (!ukryteStacje.includes(pozycja.url)) ukryteStacje.push(pozycja.url);
    mojeStacje.push({
      nazwa: nazwa.trim().slice(0, 60),
      url: url.trim(),
      kategoria: kategoriaKatalogu === 'internet' ? 'tematyczne' : kategoriaKatalogu
    });
  }
  zapiszMojeStacje();
  rysujKatalog();
}


function rysujKatalog() {
  const lista = aktywnaLista();
  const szukane = el('szukaj').value.trim().toLowerCase();
  const pojemnik = el('listaKatalogu');
  pojemnik.innerHTML = '';

  const zSieci = kategoriaKatalogu === 'internet';
  let zrodlo;
  if (zSieci) {
    zrodlo = wynikiSieci.map(w => Object.assign({}, w, { zSieci: true }));
  } else if (szukane) {
    zrodlo = wszystkiePozycje().filter(p => p.nazwa.toLowerCase().includes(szukane));
  } else {
    zrodlo = pozycjeKategorii(kategoriaKatalogu);
  }

  zrodlo.forEach(pozycja => {
    const wKatalogu = !pozycja.zSieci || wszystkiePozycje().some(p => p.url === pozycja.url);
    const naLiscie = lista.stacje.some(s => s.url === pozycja.url);

    const nieodtwarzalna = POD_HTTPS && !trybSerwera && pozycja.url.toLowerCase().startsWith('http://');
    const wiersz = document.createElement('button');
    wiersz.className = 'wiersz' + (naLiscie ? ' dodana' : '') + (nieodtwarzalna ? ' niedostepna' : '');
    if (nieodtwarzalna) wiersz.title = 'Nadaje po zwykłym http — w tej wersji próba pójdzie przez https';

    const tekst = document.createElement('span');
    tekst.className = 'tekst-wiersza';
    tekst.textContent = pozycja.nazwa;

    if (pozycja.wlasna) {
      tekst.append(Object.assign(document.createElement('span'),
        { className: 'znacznik-wlasna', textContent: 'moja' }));
    }
    if (pozycja.zSieci) {
      const opis = [pozycja.kraj, pozycja.kodek, pozycja.bitrate ? pozycja.bitrate + ' kb/s' : '', pozycja.tagi]
        .filter(Boolean).join(' · ');
      if (opis) {
        tekst.append(Object.assign(document.createElement('span'),
          { className: 'opis-stacji', textContent: opis }));
      }
      if (wKatalogu) {
        tekst.append(Object.assign(document.createElement('span'),
          { className: 'znacznik-wlasna', textContent: 'już mam' }));
      }
    }

    wiersz.appendChild(tekst);

    if (trybKatalogu && !zSieci) {
      wiersz.append(
        przyciskWiersza('olowek-wiersza', '\u270E', 'Popraw nazwę lub adres',
          () => edytujPozycjeKatalogu(pozycja)),
        przyciskWiersza('usun-z-katalogu', '\u00d7', 'Usuń z katalogu na stałe', () => {
          if (confirm('Usunąć "' + pozycja.nazwa + '" z katalogu?')) usunZKataloguNaStale(pozycja);
        })
      );
    } else {
      const znak = document.createElement('span');
      znak.className = 'znak';
      znak.textContent = zSieci ? '+' : (naLiscie ? '\u2713' : '+');
      wiersz.appendChild(znak);
      wiersz.addEventListener('click', () => {
        if (zSieci) dodajZSieci(pozycja);
        else przelaczZKatalogu(pozycja);
      });
    }

    pojemnik.appendChild(wiersz);
  });

  // w trybie edycji: mozliwosc cofniecia usuniec w tej kategorii
  if (trybKatalogu && !zSieci) {
    const wKategorii = (KATALOG.find(k => k.id === kategoriaKatalogu) || { pozycje: [] })
      .pozycje.filter(p => ukryteStacje.includes(p.url)).length;
    if (wKategorii) {
      const cofnij = document.createElement('button');
      cofnij.className = 'wiersz przywroc';
      cofnij.textContent = 'Przywróć usunięte z tej kategorii (' + wKategorii + ')';
      cofnij.addEventListener('click', () => przywrocUkryte(kategoriaKatalogu));
      pojemnik.appendChild(cofnij);
    }
  }

  if (!zrodlo.length && !zSieci) {
    pojemnik.appendChild(Object.assign(document.createElement('div'),
      { className: 'pusto', textContent: 'Nic tu nie ma — dodaj stację albo poszukaj w sieci.' }));
  }

  el('licznikListy').textContent = lista.nazwa + ': ' + lista.stacje.length + ' z ' + MAKS_STACJI;
  el('btnEdytujKatalog').classList.toggle('ukryty', zSieci);
  el('btnZakresSieci').classList.toggle('ukryty', !zSieci);
}

function przyciskWiersza(klasa, tresc, tytul, akcja) {
  const guzik = document.createElement('span');
  guzik.className = klasa;
  guzik.setAttribute('role', 'button');
  guzik.setAttribute('tabindex', '0');
  guzik.title = tytul;
  guzik.textContent = tresc;
  guzik.addEventListener('click', z => { z.stopPropagation(); akcja(); });
  guzik.addEventListener('keydown', z => {
    if (z.key === 'Enter' || z.key === ' ') { z.stopPropagation(); z.preventDefault(); akcja(); }
  });
  return guzik;
}

function dodajZSieci(pozycja) {
  otworzFormularz(null);
  el('poleNazwa').value = pozycja.nazwa;
  el('poleUrl').value = pozycja.url;
  el('poleKategoria').value = 'tematyczne';
  el('poleNazwa').focus();
  el('poleNazwa').select();
}

function przelaczZKatalogu(pozycja) {
  const lista = aktywnaLista();
  const istnieje = lista.stacje.find(s => s.url === pozycja.url);
  if (istnieje) {
    usunStacje(istnieje.id);
  } else {
    if (lista.stacje.length >= MAKS_STACJI) {
      el('stopka').textContent = 'Lista "' + lista.nazwa + '" jest pelna - usun cos albo zaloz nowa liste';
      return;
    }
    lista.stacje.push({ id: nowyId(), nazwa: pozycja.nazwa, url: pozycja.url });
    zapisz(); rysujKafelki();
  }
  rysujKatalog();
}

/* --- formularz --- */

function otworzFormularz(stacja) {
  idEdytowanej = stacja ? stacja.id : null;
  el('tytulForm').textContent = stacja ? 'Edycja stacji' : 'Nowa stacja';
  el('poleNazwa').value = stacja ? stacja.nazwa : '';
  el('poleUrl').value = stacja ? stacja.url : '';
  el('bladForm').classList.add('ukryty');
  el('poleKategoria').value = '';
  el('blokKatalogu').classList.toggle('ukryty', !!stacja);
  el('btnUsunStacje').classList.toggle('ukryty', !stacja);
  el('panelKatalog').classList.add('ukryty');
  el('panelWyglad').classList.add('ukryty');
  el('zaslona').classList.remove('ukryty');
  el('panelForm').classList.remove('ukryty');
  el('poleNazwa').focus();
}

function zapiszFormularz() {
  const lista = aktywnaLista();
  const nazwa = el('poleNazwa').value.trim();
  const url = el('poleUrl').value.trim();
  const blad = el('bladForm');

  if (!nazwa) { blad.textContent = 'Podaj nazwę stacji'; blad.classList.remove('ukryty'); return; }
  if (!/^https?:\/\/.+/i.test(url)) { blad.textContent = 'Adres musi zaczynać się od http:// lub https://'; blad.classList.remove('ukryty'); return; }

  if (idEdytowanej) {
    const stacja = lista.stacje.find(s => s.id === idEdytowanej);
    if (stacja) { stacja.nazwa = nazwa; stacja.url = url; delete stanStacji[stacja.url]; }
    zapisz(); rysujKafelki(); odswiezWyswietlacz();
    zamknijPanele();
    return;
  }

  // dopisanie do katalogu na stale, jesli wybrano kategorie
  const kategoria = el('poleKategoria').value;
  let komunikat = '';
  if (kategoria) {
    const juzJest = wszystkiePozycje().some(p => p.url === url);
    if (juzJest) {
      komunikat = 'Ta stacja już jest w katalogu';
    } else {
      mojeStacje.push({ nazwa, url, kategoria });
      zapiszMojeStacje();
      const nazwaKat = (KATALOG.find(k => k.id === kategoria) || {}).nazwa || kategoria;
      komunikat = '"' + nazwa + '" dopisana do katalogu w kategorii ' + nazwaKat;
    }
  }

  // i dodanie na biezaca liste, jesli jest jeszcze miejsce
  if (lista.stacje.length < MAKS_STACJI) {
    lista.stacje.push({ id: nowyId(), nazwa, url });
    zapisz(); rysujKafelki(); odswiezWyswietlacz();
  } else if (kategoria) {
    komunikat += ' — lista "' + lista.nazwa + '" jest pełna, więc na kafelki jej nie dodałem';
  } else {
    blad.textContent = 'Ta lista ma już 12 stacji';
    blad.classList.remove('ukryty');
    return;
  }

  if (komunikat) el('stopka').textContent = komunikat;
  zamknijPanele();
}

function usunStacje(id) {
  const lista = aktywnaLista();
  lista.stacje = lista.stacje.filter(s => s.id !== id);
  if (idBiezacej === id) {
    if (most) most.pauza();
    else { audio.pause(); audio.removeAttribute('src'); }
    idBiezacej = null;
    clearInterval(timerUtworu);
    ustawUtwor('');
  }
  zapisz(); rysujKafelki(); odswiezWyswietlacz(); ustawWskazniki();
}

function zamknijPanele() {
  el('panelForm').classList.add('ukryty');
  el('panelKatalog').classList.add('ukryty');
  el('panelWyglad').classList.add('ukryty');
  el('zaslona').classList.add('ukryty');
  if (trybKatalogu) przelaczTrybKatalogu();
}

/* --- zdarzenia --- */

el('btnPlay').addEventListener('click', przelaczOdtwarzanie);
el('btnPoprzednia').addEventListener('click', () => przelacz(-1));
el('btnNastepna').addEventListener('click', () => przelacz(1));

el('btnWycisz').addEventListener('click', () => {
  ustawWyciszenieSilnika(!czyCisza());
  ustawWskazniki();
});

el('suwak').addEventListener('input', () => {
  const poziom = Number(el('suwak').value) / 100;
  ustawGlosnoscSilnika(poziom);
  if (czyCisza() && poziom > 0) { ustawWyciszenieSilnika(false); ustawWskazniki(); }
  zapiszUstawienia();
});

audio.addEventListener('playing', () => { odswiezWyswietlacz(); ustawWskazniki(); pobierzUtwor();
  const s = biezacaStacja(); if (s) { stanStacji[s.url] = 'dziala'; rysujKafelki(); } });
audio.addEventListener('pause', () => { odswiezWyswietlacz(); ustawWskazniki(); });
audio.addEventListener('error', pokazBlad);

el('btnKolejnosc').addEventListener('click', przelaczTrybEdycji);
el('btnSprawdz').addEventListener('click', () => sprawdzStacje(false));
el('btnZmienNazwe').addEventListener('click', zmienNazweListy);
el('btnUsunListe').addEventListener('click', usunListe);
el('btnWlasna').addEventListener('click', () => otworzFormularz(null));
el('btnZapisz').addEventListener('click', zapiszFormularz);
el('btnUsunStacje').addEventListener('click', () => { if (idEdytowanej) usunStacje(idEdytowanej); zamknijPanele(); });
el('btnEdytujKatalog').addEventListener('click', przelaczTrybKatalogu);
el('btnZakresSieci').addEventListener('click', przelaczZakresSieci);
el('btnOtworzKatalog').addEventListener('click', otworzKatalog);
el('btnWyglad').addEventListener('click', otworzWyglad);
el('btnOdswiez').addEventListener('click', odswiezPolaczenie);
el('btnRestartSieci').addEventListener('click', restartSieci);
el('btnRestartApki').addEventListener('click', restartAplikacji);

el('szukaj').addEventListener('input', () => {
  if (kategoriaKatalogu !== 'internet') { rysujKatalog(); return; }
  clearTimeout(timerSzukania);
  const fraza = el('szukaj').value;
  if (fraza.trim().length < 2) return;
  timerSzukania = setTimeout(() => szukajWSieci(fraza), 700);   // czekamy, az przestanie pisac
});

el('szukaj').addEventListener('keydown', z => {
  if (z.key !== 'Enter' || kategoriaKatalogu !== 'internet') return;
  clearTimeout(timerSzukania);
  szukajWSieci(el('szukaj').value);
});

document.querySelectorAll('[data-zamknij]').forEach(g => g.addEventListener('click', zamknijPanele));
el('zaslona').addEventListener('click', zamknijPanele);

['poleNazwa', 'poleUrl', 'poleKategoria'].forEach(id => {
  el(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') zapiszFormularz();
    if (e.key === 'Escape') zamknijPanele();
  });
});

document.addEventListener('keydown', e => {
  if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
  const lista = aktywnaLista();
  if (e.key >= '1' && e.key <= '9' && lista) {
    const stacja = lista.stacje[Number(e.key) - 1];
    if (stacja) wlacz(stacja);
  }
  if (e.code === 'Space')      { e.preventDefault(); przelaczOdtwarzanie(); }
  if (e.code === 'ArrowLeft')  { e.preventDefault(); przelacz(-1); }
  if (e.code === 'ArrowRight') { e.preventDefault(); przelacz(1); }
  if (e.key === 'm' || e.key === 'M') { ustawWyciszenieSilnika(!czyCisza()); ustawWskazniki(); }
});

/* --- start --- */

(function start() {
  let ustawienia = {};
  try { ustawienia = JSON.parse(localStorage.getItem(KLUCZ_USTAW)) || {}; } catch (e) {}

  wybranePalety = ustawienia.palety || {};
  // Terminal został usunięty — kto go miał wybranego, dostaje Auto
  const skorka = SKORKI.some(s => s.id === ustawienia.skorka) ? ustawienia.skorka : 'auto';
  document.body.dataset.skorka = skorka;
  document.body.dataset.paleta = wybranePalety[skorka] || DOMYSLNE_PALETY[skorka] || 'stal';

  wczytaj();
  indeksListy = Math.min(ustawienia.lista || 0, listy.length - 1);

  rysujSkorki();
  rysujPalety();
  rysujZakladki();
  rysujKafelki();
  odswiezWyswietlacz();
  ustawWskazniki();
  odswiezZegar();
  dopasujSkale();
  setInterval(odswiezZegar, 1000);

  if (ustawienia.glosnosc !== undefined) el('suwak').value = ustawienia.glosnosc;
  ustawGlosnoscSilnika(Number(el('suwak').value) / 100);

  wczytajMojeStacje();

  dopasujSkale();
  if (most) {
    setTimeout(() => { wznowOstatniaStacje(); sprawdzSamoczynnie(); }, 600);
  }

  fetch('/api/status')
    .then(odp => {
      if (!odp.ok) throw new Error('brak serwera');
      trybSerwera = true;
      el('stopka').textContent = 'Klawisze 1-9 wybierają stację · strzałki przełączają · spacja pauzuje · M wycisza · przytrzymaj kafelek, żeby zmienić kolejność';
    })
    .catch(() => {
      trybSerwera = false;
      if (most) {
        el('stopka').textContent = 'Radio gra w tle · sterowanie z kierownicy i ekranu blokady';
      } else if (POD_HTTPS) {
        el('stopka').textContent = 'Wersja przenośna — bez tytułów utworów; stacje po zwykłym http odtwarzam przez https, nie każda zagra';
      } else {
        el('stopka').textContent = 'Wersja przenośna — bez tytułów utworów';
      }
    });
})();
