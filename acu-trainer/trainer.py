"""Jednoduchy trainer pro Assassin's Creed Unity (singleplayer).

Adresy se nastavuji v config.json - najdes je v Cheat Engine (viz README.md).
Spustit jako spravce:  python trainer.py
"""
import json
import sys
import time
from pathlib import Path

import keyboard
import pymem
import pymem.process

CONFIG_PATH = Path(__file__).with_name("config.json")
TICK = 0.1  # jak casto se prepisuji zmrazene hodnoty (s)


def load_config():
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


def resolve(pm, module_base, cheat):
    """Prevede pointer z Cheat Engine ("ACU.exe"+base, offsety) na adresu."""
    addr = module_base + int(cheat["base"], 16)
    offsets = [int(o, 16) for o in cheat.get("offsets", [])]
    if not offsets:
        return addr
    addr = pm.read_ulonglong(addr)
    for off in offsets[:-1]:
        addr = pm.read_ulonglong(addr + off)
    return addr + offsets[-1]


def write_value(pm, addr, value_type, value):
    if value_type == "float":
        pm.write_float(addr, float(value))
    else:
        pm.write_int(addr, int(value))


def main():
    config = load_config()
    process_name = config["process"]

    print(f"Cekam na {process_name}...")
    while True:
        try:
            pm = pymem.Pymem(process_name)
            break
        except pymem.exception.ProcessNotFound:
            time.sleep(1)

    module = pymem.process.module_from_name(pm.process_handle, process_name)
    module_base = module.lpBaseOfDll
    print(f"Pripojeno k {process_name}\n")

    cheats = [c for c in config["cheats"] if c.get("base")]
    if not cheats:
        print("V config.json nejsou vyplnene zadne adresy. Navod je v README.md.")
        sys.exit(1)

    active = {c["name"]: False for c in cheats}

    def toggle(cheat):
        active[cheat["name"]] = not active[cheat["name"]]
        state = "ZAP" if active[cheat["name"]] else "VYP"
        print(f"[{cheat['hotkey'].upper()}] {cheat['name']}: {state}")

    for cheat in cheats:
        keyboard.add_hotkey(cheat["hotkey"], toggle, args=(cheat,))
        print(f"  {cheat['hotkey'].upper():>4}  {cheat['name']}")
    print("\nUkonceni: Ctrl+C\n")

    try:
        while True:
            for cheat in cheats:
                if not active[cheat["name"]]:
                    continue
                try:
                    addr = resolve(pm, module_base, cheat)
                    write_value(pm, addr, cheat.get("type", "int"), cheat["value"])
                except pymem.exception.MemoryReadError:
                    pass  # treba v loading screenu pointer jeste neexistuje
                except pymem.exception.MemoryWriteError:
                    pass
            time.sleep(TICK)
    except KeyboardInterrupt:
        print("Konec.")


if __name__ == "__main__":
    main()
