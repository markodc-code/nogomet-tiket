# Nogometni tiket

Upišeš parove iz 22 europske lige (Engleska 1.–5. liga, Škotska 1.–4., Njemačka, Italija, Španjolska i Francuska 1.–2., Nizozemska, Portugal, Belgija, Turska, Grčka) i što si odigrao, a aplikacija iz statistike izračuna šansu da tiket prođe. Spremljene tikete sama provjerava kad utakmice završe.

## Kako radi

- `build_data.py` skine rezultate i kvote s [football-data.co.uk](https://www.football-data.co.uk) (zadnje 3 sezone), izračuna snagu napada i obrane svake momčadi (Dixon-Coles model) i sve spremi u `web/data.json`.
- `web/` je cijela aplikacija: stranica sama računa šanse iz `data.json`, a tikete pamti u pregledniku na uređaju.
- Na GitHubu `.github/workflows/objava.yml` tri puta dnevno osvježi podatke i objavi stranicu (GitHub Pages).

## Na računalu

Dvoklik na `Pokreni.bat` (treba Python 3). Otvori se http://127.0.0.1:8765.

## Na iPhoneu

Otvori adresu stranice u Safariju, pa Dijeli → **Dodaj na početni zaslon**. Tiketi se spremaju na mobitelu; u „Moji tiketi“ možeš spremiti sigurnosnu kopiju.

## Provjera točnosti

`python backtest.py` za svaku ligu na prošloj sezoni računa šanse samo iz utakmica odigranih prije svake runde i uspoređuje ih sa stvarnim rezultatima i s kvotama. Rezultat ide u `tocnost.json`, iz kojeg se za svaku ligu uzima koliko se oslanjamo na kvote. Pokreni ga jednom po sezoni.
