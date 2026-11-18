#!/usr/bin/env python3
"""Put classes.dex into the APK that aapt2 made, aligned like zipalign does.

Android installs an app that targets API 30 or later only when resources.arsc is stored
uncompressed on a 4-byte boundary. Every stored (uncompressed) entry gets padding in its
local header's extra field so its data starts on a 4-byte boundary, the same thing
`zipalign -p 4` does. Usage: apkpack.py base.apk classes.dex out.apk
"""
import sys
import zipfile


def main() -> None:
    base, dex, out = sys.argv[1:4]
    with zipfile.ZipFile(base) as zin, zipfile.ZipFile(out, 'w') as zout:
        entries = [(info, zin.read(info.filename)) for info in zin.infolist()]
        with open(dex, 'rb') as f:
            dex_info = zipfile.ZipInfo('classes.dex')
            dex_info.compress_type = zipfile.ZIP_DEFLATED
            entries.append((dex_info, f.read()))
        for info, data in entries:
            fresh = zipfile.ZipInfo(info.filename, date_time=info.date_time)
            fresh.compress_type = info.compress_type
            fresh.external_attr = info.external_attr
            if fresh.compress_type == zipfile.ZIP_STORED:
                offset = zout.fp.tell()
                header = 30 + len(fresh.filename.encode('utf-8'))
                fresh.extra = b'\0' * ((4 - (offset + header) % 4) % 4)
            zout.writestr(fresh, data)


if __name__ == '__main__':
    main()
