# Laporan stabilisasi E2E dan investigasi Enter di Search

Branch `motion-engine`. Belum ada commit, push, PR, atau merge. `npm test`: 660 lulus, 0 gagal (656 + 4 tes baru).
Hasil E2E per run ada di `report.md`.

## 1. Hasil POC berulang
- Sebelum perbaikan: 3 dari 3 run POC gagal untuk Search (tidak terbuka, Enter tidak bekerja). Dock dan Island lulus 3 dari 3.
- Setelah perbaikan: 5 sesi, 15 dari 15 skenario lulus, 0 error log shell.
- Suite 15 skenario: 3 sesi x 15 = 45 Pass, 0 Fail. Satu Fail di run pertama berasal dari harness (bagian 5).

## 2. Akar masalah Enter di Search
- `ClutterText` di GNOME 51 mengambil Return dan KP_Enter untuk sinyal `activate` miliknya dan tidak memancarkan `key-press-event` untuk keduanya. Tab, Down, dan Esc tetap sampai.
- Search hanya mendengarkan `key-press-event`, jadi Enter tidak pernah menjalankan hasil.
- Sudah ada sebelum motion engine: baris handler identik di merge-base `f83a9452`.
- Bukti runtime hanya dari branch ini. Perbandingan dengan paket 1.5.9 tidak bisa dilakukan karena telemetry membaca internal 1.6.0.
- Belum terbukti di keyboard fisik. Alur event virtual sama dengan libinput, tetapi belum diuji pada perangkat nyata.

## 3. Perbaikan produk
- Search juga menjalankan hasil dari sinyal `activate` entry: satu baris di `shell/search/extension.ts` dan `canActivateOnReturn` di `shell/search/searchMotion.ts`.
- Duplikasi dicegah: hanya aktif saat Opening, Ready, ResultsExpanded; tidak saat Executing atau Dismissing; guard `Once` di `_activate` tetap; jika `key-press-event` membawa Return (GNOME lama), event itu di-STOP sehingga `activate` tidak muncul.
- Handler keyboard tidak diganti.
- Regresi: `E2E-SRCH-04` gagal tanpa baris itu dan lulus dengan baris itu; 4 tes node di `tests/island/searchActivate.test.js`.
- Enter saat membuka (SRCH-05) dan saat menutup (SRCH-06) lulus 3 dari 3. Hasil yang benar-benar lambat belum diuji.

## 4. Bukti propagasi event
- Super+Space membuka Search lewat keybinding dan fokus masuk ke entry.
- Karakter mencapai entry lewat `captured-event` (21 event untuk 4 karakter, 0 `key-press-event`). Tab dan Down memicu `_onKey`. Return dan KP_Enter hanya memicu `activate`.
- Pointer relatif menghasilkan enter dan motion di stage; `hovered` Island menjadi true; Dock magnifikasi.

## 5. Klasifikasi flakiness
| Kegagalan | Kelas | Penyebab |
|---|---|---|
| Search tidak terbuka, 3 dari 3 run POC | Lingkungan/harness | Super+Space bawaan GNOME terikat ke ganti sumber input dan berebut dengan shortcut Search. Desktop pengguna sudah melepasnya (`['XF86Keyboard']`), sesi E2E kini meniru itu. Lalu 5 dari 5 sesi lulus. |
| Island tidak expand | Harness | Target diambil dari ukuran peek lama. Sekarang menunggu bentuk compact. |
| SRCH-06 Fail sekali | Harness | Event aplikasi dari skenario sebelumnya terhitung. Sekarang difilter per skenario. |
| Enter tidak aktif | Produk | Bagian 2. |

Catatan produk, belum diselidiki: pada GNOME bawaan dengan dua layout, shortcut default Search berbenturan dengan ganti sumber input.
Sampel kecil (5 sesi POC, 3 sesi suite); jangan dibaca sebagai klaim stabilitas jangka panjang.

## 6. Keamanan telemetry (`org.niro.E2E`)
`tests/e2e/audit_telemetry.py`: 20 pemeriksaan, semuanya OK.
- Nonaktif secara default: dengan `NIRO_E2E=0` nama bus tidak dimiliki. Tidak ikut paket.
- Lima metode tetap, tanpa properti atau sinyal. `Start` hanya menerima `[a-z0-9_-]{1,60}`; delapan nama jahat ditolak; tidak ada file di luar `NIRO_E2E_OUT`.
- Tanpa eval: `org.gnome.Shell.Eval` ditolak karena sesi tidak memakai unsafe mode.
- Data terbuka: pointer, geometri, state, hitungan event, dan teks query Search. Tidak ada clipboard, file, atau kredensial.
- Teardown: 5 siklus disable/enable melepas dan memiliki ulang nama bus.
- Risiko sisa: jika diaktifkan di sesi nyata dengan `NIRO_E2E=1`, klien bus mana pun bisa membaca data di atas. Telemetry juga membaca field privat tiga ekstensi.

## 7. Cakupan otomatis baru
15 skenario E2E (Search 7, Dock 2, Island 2, lintas 2, reduced motion 1, lifecycle 1), runner `tests/e2e/run.sh`, `npm run test:e2e`.
Belum dicakup: Island voice, peek, alert, split; hasil pencarian lambat; urgency aplikasi nyata; reduced motion Dock dan Island; multi-monitor; HiDPI; lock/unlock; frame pacing GPU.

## 8. UAT manual yang tersisa
- Semua 42 skenario UAT masih Not run. Hasil E2E tidak mengubah satu pun menjadi Pass.
- UAT-SRCH-04: salinan UAT di desktop adalah build sebelum perbaikan Enter. Uji dulu Enter dengan build itu, lalu `tests/uat/uat.sh install` dan login ulang untuk build yang diperbaiki.
- Muat ulang probe di Looking Glass (hook kini `captured-event`).

## 9. Hitungan tes
`npm test`: 660 lulus, 0 gagal. POC 15/15 (5 sesi). Suite 45/45 (3 sesi). Audit telemetry 20/20.

## 10. Kesiapan commit
Siap di-commit lokal, belum di-commit. Usulan dua commit: (1) perbaikan Search Enter beserta tes dan probe; (2) infrastruktur E2E, UAT, dan dokumen.
Perubahan terpisah yang ikut tertunda: sidebar Niro Control (`control/src/window.ts`) kini dibungkus `Gtk.ScrolledWindow`; sebaiknya commit ketiga sendiri.
Perbaikan Enter mengubah perilaku Search yang dipakai pengguna, jadi konfirmasi di keyboard fisik tetap dibutuhkan sebelum PR.
