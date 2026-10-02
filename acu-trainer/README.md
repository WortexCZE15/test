# Trainer pro Assassin's Creed Unity

Jednoduchý trainer s klávesovými zkratkami (F1–F4), který „zmrazí“ vybrané hodnoty ve hře: peníze, zdraví, náboje a kouřové bomby.

> **Jen pro singleplayer.** Nepoužívej ho v co-op misích s ostatními hráči. Pro jistotu hraj v offline režimu Ubisoft Connect.

## Proč tam nejsou adresy rovnou
Adresy v paměti se liší podle verze hry (Steam / Ubisoft Connect, patch). Natvrdo zadané adresy by u tebe nejspíš nefungovaly, takže si je najdeš sám v Cheat Engine. Je to asi 10 minut práce na jednu hodnotu.

## 1. Instalace
1. Nainstaluj [Python 3](https://www.python.org/downloads/) a při instalaci zaškrtni **Add Python to PATH**.
2. V téhle složce otevři příkazový řádek a spusť:
   ```
   pip install -r requirements.txt
   ```
3. Nainstaluj [Cheat Engine](https://www.cheatengine.org/), stahuj jen z oficiálního webu.

## 2. Najdi adresu (příklad: peníze)
1. Spusť hru, načti uloženou pozici a podívej se, kolik máš peněz (např. `12500`).
2. V Cheat Engine klikni na ikonu počítače vlevo nahoře a vyber **ACU.exe**.
3. Do **Value** napiš `12500`, typ nech **4 Bytes** a klikni **First Scan**.
4. Ve hře utrať nebo vydělej peníze, napiš novou částku a klikni **Next Scan**.
5. Opakuj to, dokud nezůstane jen pár adres. Dvojklikem přidej adresu dolů a změnou hodnoty ověř, že se peníze ve hře změnily.

## 3. Najdi pointer (aby adresa platila i po restartu hry)
Adresa z kroku 2 se po restartu hry změní, proto potřebuješ **pointer**:
1. Pravým tlačítkem klikni na adresu a vyber **Pointer scan for this address** → **OK** a ulož.
2. Restartuj hru, znovu najdi novou adresu peněz (krok 2).
3. V okně pointer scanu dej **Pointer scanner → Rescan memory**, zadej novou adresu a potvrď.
4. Vyber pointer, který začíná na `"ACU.exe"+...` a má co nejméně offsetů.

Výsledek vypadá třeba takhle: `"ACU.exe"+0x51A2B30` → offsety `0x40, 0x18, 0x2C`.

## 4. Zapiš to do `config.json`
```json
{
  "name": "Nekonecne penize",
  "hotkey": "f1",
  "type": "int",
  "value": 9999999,
  "base": "0x51A2B30",
  "offsets": ["0x40", "0x18", "0x2C"]
}
```
- `base` je číslo za `"ACU.exe"+`
- `offsets` jsou offsety ve stejném pořadí, jak je ukazuje Cheat Engine (od prvního po poslední)
- pokud CE hledal typ **Float**, dej `"type": "float"`
- cheaty s prázdným `base` trainer přeskočí

## 5. Spusť trainer
1. Spusť hru.
2. Otevři příkazový řádek **jako správce** (bez toho nepůjde zapisovat do paměti hry ani chytat klávesy).
3. Spusť:
   ```
   python trainer.py
   ```
4. Ve hře mačkej F1–F4 pro zapnutí a vypnutí.

## Když to nefunguje
- **Nic se neděje:** spusť trainer jako správce.
- **Hodnota se nemění:** pointer je špatný, zkus jiný z pointer scanu.
- **Hra spadne:** do adresy se zapisuje špatný typ (`int` vs `float`), nebo pointer míří jinam.
- **Po updatu hry přestane fungovat:** najdi pointery znovu.
