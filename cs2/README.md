# CS2 cheaty pro hru s boty

Vestavěné příkazy z konzole CS2. Fungují jen offline, na tvém vlastním serveru („Hrát s boty“ / „Practice“). Na oficiálních ani komunitních serverech to nepůjde, protože tam je `sv_cheats` vypnuté.

## Jak to rozjet
1. Zapni vývojářskou konzoli: **Nastavení → Hra → Povolit vývojářskou konzoli (~) → Ano**.
2. Zkopíruj `cheats.cfg` do složky
   `Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\cfg\`
3. Spusť hru s boty, otevři konzoli klávesou `~` (vlevo od 1) a napiš:
   ```
   exec cheats
   ```

## Klávesy (po `exec cheats`)
| Klávesa | Co dělá |
|---|---|
| N | noclip (létání skrz zdi) |
| G | god mode (nesmrtelnost) |
| H | znovu hodí poslední granát |
| J | zpomalení času zap/vyp |
| K | zmrazení botů zap/vyp |

## Užitečné příkazy do konzole
| Příkaz | Co dělá |
|---|---|
| `give weapon_awp` | dá ti zbraň (`weapon_ak47`, `weapon_m4a1_silencer`, `weapon_deagle`, `weapon_hegrenade`, `weapon_smokegrenade`, `weapon_flashbang`, `weapon_molotov`…) |
| `bot_kick` | vyhodí všechny boty |
| `bot_add_t` / `bot_add_ct` | přidá bota za T / CT |
| `bot_difficulty 0`–`3` | obtížnost botů (0 = nejlehčí) |
| `bot_dont_shoot 1` | boti nestřílí |
| `bot_stop 1` | boti stojí na místě |
| `bot_crouch 1` | boti se krčí |
| `mp_restartgame 1` | restart hry |
| `host_timescale 0.5` | zpomalení (1 = normál) |
| `sv_infinite_ammo 1` | nekonečné náboje |
| `noclip` / `god` | létání / nesmrtelnost |
| `mp_warmup_end` | ukončí warmup |

Pokud nějaký příkaz nefunguje, nejdřív zadej `sv_cheats 1`.
