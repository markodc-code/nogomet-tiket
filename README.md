# Nogometni tiket

Upišeš parove iz lige petice i što si odigrao, a aplikacija iz statistike izračuna šansu da tiket prođe. Spremljene tikete sama provjerava kad utakmice završe.

## Kako radi

- `build_data.py` skine rezultate i kvote s [football-data.co.uk](https://www.football-data.co.uk) (zadnje 3 sezone), izračuna snagu napada i obrane svake momčadi (Dixon-Coles model) i sve spremi u `web/data.json`.
- `web/` je cijela aplikacija: stranica sama računa šanse iz `data.json`, a tikete pamti u pregledniku na uređaju.
- Na GitHubu `.github/workflows/objava.yml` tri puta dnevno osvježi podatke i objavi stranicu (GitHub Pages).

## Na računalu

Dvoklik na `Pokreni.bat` (treba Python 3). Otvori se http://127.0.0.1:8765.

## Na iPhoneu

Otvori adresu stranice u Safariju, pa Dijeli → **Dodaj na početni zaslon**. Tiketi se spremaju na mobitelu; u „Moji tiketi“ možeš spremiti sigurnosnu kopiju.
