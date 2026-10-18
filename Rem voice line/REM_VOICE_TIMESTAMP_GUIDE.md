# AI CLI Guide — Timestamp & Split Voice Lines Rem

## Tujuan

Gunakan panduan ini untuk membuat timestamp akurat bagi setiap dialog di audio TTS Rem, lalu mengekspor metadata JSON dan—jika diminta—memotong setiap dialog menjadi file audio tersendiri untuk proyek virtual pet desktop.

**Jangan mengarang timestamp.** Timestamp harus ditentukan dari audio yang sebenarnya melalui transkripsi bertimestamp, analisis waveform/VAD, atau pemeriksaan audio. Jika batas dialog tidak jelas, tandai untuk tinjauan manual.

## 1. Struktur file sumber

Cari file audio di folder voice/audio yang memang digunakan oleh proyek. Periksa struktur proyek terlebih dahulu; jangan mengasumsikan path tertentu dan jangan memindahkan atau mengganti nama file sumber.

File yang diharapkan berdasarkan nama pada folder pengguna:

| Nama dasar file | Kategori JSON |
|---|---|
| `Daily Conversation 2` | `daily_2` |
| `Daily Conversation` | `daily` |
| `Funny Reactions` | `funny` |
| `Greeting 2` | `greeting_2` |
| `Greeting` | `greeting` |
| `Interactive Conversation 2` | `interactive_2` |
| `Interactive Conversation` | `interactive` |
| `night` | `night` |
| `Work & Study 2` | `work_2` |
| `Work & Study` | `work` |

Ekstensi file tidak diketahui dari nama yang terlihat. Deteksi ekstensi sebenarnya, misalnya `.wav`, `.mp3`, `.m4a`, atau format audio lain yang didukung. Jangan membuat asumsi bahwa semua file memiliki ekstensi atau format yang sama.

### Pencocokan nama file

- Cocokkan nama dasar file secara tepat, tanpa membedakan huruf besar/kecil bila sistem file mengharuskannya.
- `Greeting` dan `Greeting 2` adalah dua sumber yang berbeda.
- `Daily Conversation` dan `Daily Conversation 2` adalah dua sumber yang berbeda.
- Jangan sampai pencarian nama parsial menganggap versi tanpa angka sebagai versi bernomor, atau sebaliknya.
- Jika ditemukan beberapa file dengan nama dasar yang sama di folder berbeda, laporkan semuanya dan gunakan folder audio yang relevan dengan proyek. Jangan memilih secara diam-diam.
- Jika ada file yang tidak ditemukan, lanjutkan memproses file yang tersedia dan laporkan nama yang hilang.

## 2. Tugas yang harus dilakukan AI CLI

1. Periksa struktur proyek, file audio, dependensi yang tersedia, serta apakah sudah ada kode atau skema JSON untuk voice line.
2. Temukan sepuluh nama dasar file di atas pada folder audio proyek.
3. Baca metadata setiap audio dan dapatkan durasi aktualnya.
4. Analisis audio satu per satu. Setiap file memiliki garis waktu sendiri yang dimulai pada detik `0`.
5. Transkripsikan ucapan dan tentukan batas awal serta akhir untuk **setiap dialog individual**, bukan hanya setiap paragraf atau keseluruhan file.
6. Gunakan ASR dengan word/segment timestamps jika tersedia. Gunakan VAD atau waveform sebagai bantuan untuk menemukan jeda, tetapi jangan mengandalkan keheningan saja untuk menentukan batas dialog.
7. Cocokkan transkripsi dengan naskah sumber jika tersedia. Teks JSON harus mencerminkan kata yang benar-benar terdengar. Tandai perbedaan, dialog yang terlewat, atau pengucapan yang tidak jelas.
8. Tulis satu file JSON untuk setiap audio sumber ke folder output timestamp.
9. Jika fitur pemotongan diaktifkan atau diminta, buat satu file audio untuk setiap dialog berdasarkan timestamp JSON.
10. Validasi seluruh JSON dan timestamp. Jangan mengubah, menghapus, atau menimpa file sumber.
11. Berikan ringkasan hasil, file yang gagal diproses, serta bagian yang memerlukan pemeriksaan manual.

## 3. Aturan timestamp

- `start` dan `end` menggunakan detik desimal, misalnya `12.345`.
- `start` adalah awal ucapan yang ingin dipertahankan; `end` adalah akhir ucapan yang ingin dipertahankan.
- Jangan memotong konsonan, suku kata, atau kata pada awal/akhir dialog.
- Sisakan sedikit jeda alami bila dibutuhkan agar klip tidak terasa terpotong. Jika memakai padding, dokumentasikan atau terapkan secara konsisten.
- Jangan memasukkan keheningan panjang yang tidak perlu.
- Pertahankan napas, tawa, atau jeda ekspresif jika merupakan bagian dari performa suara.
- Jangan menghitung timestamp dari jumlah karakter atau durasi rata-rata kalimat.
- Timestamp harus berada dalam rentang `0 <= start < end <= duration_seconds`.
- Dialog harus tersusun sesuai urutan aslinya. Jangan mengurutkan berdasarkan teks atau ID secara alfabetis.
- Jika dua dialog menyatu tanpa jeda yang jelas, gunakan timestamp ASR atau tinjauan audio. Jangan membagi secara spekulatif tanpa memberi catatan.
- `confidence` adalah nilai antara `0.0` dan `1.0` yang menggambarkan keyakinan pada transkripsi dan batas klip. Gunakan nilai rendah atau catatan ketika ada ketidakpastian; jangan memberi nilai tinggi tanpa bukti.

## 4. Format JSON yang diwajibkan

Buat satu JSON per audio. Contoh berikut hanya ilustrasi format, bukan timestamp nyata:

```json
{
  "schema_version": "1.0",
  "source_file": "Daily Conversation.wav",
  "category": "daily",
  "duration_seconds": 42.731,
  "language": "id",
  "clips": [
    {
      "id": "daily_001",
      "text": "Teks dialog yang benar-benar terdengar.",
      "start": 0.42,
      "end": 3.18,
      "confidence": 0.95,
      "notes": ""
    },
    {
      "id": "daily_002",
      "text": "Dialog berikutnya yang benar-benar terdengar.",
      "start": 4.05,
      "end": 6.44,
      "confidence": 0.88,
      "notes": "Periksa batas akhir."
    }
  ]
}
```

### Aturan field

- `schema_version`: selalu `"1.0"`.
- `source_file`: nama file sumber beserta ekstensi sebenarnya.
- `category`: kategori yang dipetakan dari tabel nama file.
- `duration_seconds`: durasi aktual file audio dalam detik.
- `language`: gunakan `"id"` untuk Bahasa Indonesia.
- `clips`: daftar dialog dalam urutan audio.
- `id`: ID unik yang stabil, misalnya `daily_001`, `greeting_2_001`, atau `interactive_2_001`.
- `text`: teks ucapan yang terdengar pada klip. Jangan menambahkan kata yang tidak diucapkan.
- `start`: waktu awal dalam detik.
- `end`: waktu akhir dalam detik.
- `confidence`: angka dari `0.0` hingga `1.0`.
- `notes`: string kosong jika tidak ada masalah; jika ragu, jelaskan apa yang harus diperiksa.

JSON harus valid dan dapat dibaca parser standar. Jangan menyertakan komentar, trailing comma, atau Markdown di dalam file JSON.

## 5. Nama output yang disarankan

Pertahankan nama dasar file sumber agar hasil mudah dicocokkan.

```text
output/
├── timestamps/
│   ├── daily.json
│   ├── daily_2.json
│   ├── funny.json
│   ├── greeting.json
│   ├── greeting_2.json
│   ├── interactive.json
│   ├── interactive_2.json
│   ├── night.json
│   ├── work.json
│   └── work_2.json
└── clips/
    ├── daily/
    │   ├── daily_001.wav
    │   └── daily_002.wav
    ├── daily_2/
    ├── funny/
    ├── greeting/
    ├── greeting_2/
    ├── interactive/
    ├── interactive_2/
    ├── night/
    ├── work/
    └── work_2/
```

Struktur di atas adalah contoh. Ikuti struktur proyek yang sudah ada bila proyek mempunyai konvensi output sendiri. Gunakan ekstensi audio output yang sesuai; WAV direkomendasikan untuk pemrosesan tanpa kehilangan kualitas, tetapi MP3 boleh digunakan jika sesuai kebutuhan proyek.

## 6. Aturan pemotongan klip

Jika membuat klip terpisah:

- Buat satu klip untuk setiap objek di `clips`.
- Nama file berasal dari ID klip, contohnya `daily_001.wav`.
- Gunakan `start` dan `end` dari JSON sebagai sumber kebenaran.
- Jangan mengubah urutan dialog.
- Jangan menimpa file input atau hasil sebelumnya tanpa izin eksplisit.
- Pastikan durasi klip masuk akal dan file dapat dibuka.
- Jika proses pemotongan menggunakan padding tambahan, hindari klip yang melampaui batas audio sumber.
- Bila timestamp JSON diperbarui, hasil klip harus dapat dibuat ulang dari JSON tersebut.

## 7. Strategi teknis

Pilih alat berdasarkan dependensi yang sudah tersedia di proyek. Bila tersedia, gunakan:
- Metadata audio untuk durasi dan sample rate.
- ASR yang mendukung timestamp segmen atau kata.
- VAD/waveform untuk membantu mendeteksi jeda.
- Pustaka pemrosesan audio yang sudah terpasang untuk pemotongan.

Jangan menganggap VAD saja dapat mengidentifikasi batas setiap kalimat dengan benar. Bila sistem hanya mampu menghasilkan batas berbasis jeda, tandai hasil sebagai perkiraan dan minta pemeriksaan manual. Jangan memasang paket baru, mengunduh model besar, atau mengubah konfigurasi sistem tanpa menjelaskan kebutuhan dan memeriksa lingkungan proyek terlebih dahulu.

## 8. Validasi kualitas

Sebelum menyelesaikan tugas, pastikan:

- [ ] Sepuluh nama dasar file telah dicari secara tepat.
- [ ] Setiap file yang ditemukan diproses secara independen.
- [ ] File yang tidak ditemukan dilaporkan.
- [ ] Durasi diambil dari audio aktual.
- [ ] Setiap dialog yang terdengar memiliki entri sendiri.
- [ ] Teks sesuai dengan audio.
- [ ] Batas awal dan akhir tidak memotong ucapan.
- [ ] Semua timestamp berada dalam durasi file.
- [ ] ID unik dan berurutan.
- [ ] Setiap JSON lolos parsing.
- [ ] Jika klip dibuat, jumlah klip sesuai jumlah entri JSON.
- [ ] File sumber tidak diubah atau ditimpa.
- [ ] Bagian yang tidak pasti diberi catatan.

## 9. Definisi selesai

Tugas selesai ketika setiap audio yang ditemukan memiliki JSON valid berisi timestamp per dialog yang didasarkan pada audio aktual. Jika pemotongan diaktifkan, setiap dialog memiliki file klip yang sesuai. Laporkan jumlah sumber yang berhasil, jumlah dialog/klip, lokasi output, serta semua ketidakpastian. Jangan mengklaim timestamp sudah akurat secara manual jika audio belum benar-benar diperiksa.
