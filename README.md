# blog.afrizzal.pro

Blog pribadi Afrizzal — **Astro 7 (static)**. Hasil build = HTML statis biasa, jadi bisa
di-host di shared hosting apa pun. **Tidak butuh PHP/MySQL saat runtime.**

> Catatan SEO: blog ini sengaja **tidak** memakai trik base64/anti-devtools seperti porto,
> supaya artikel bisa dibaca (di-crawl) oleh Google.

## Prasyarat

- **Volta** mengatur versi Node otomatis per-project (sudah terpasang).
- Folder blog ini di-**pin ke Node 22.23.4** (lihat field `"volta"` di `package.json`); project lain tetap memakai versinya sendiri. Versi ini juga menjadi minimum Node 22 pada build Hostinger.

## Sekali setup

```
npm install
```

## Menulis post

1. Buat draft:

   ```
   ./new-post.ps1 "Judul Post Saya"
   ```

   File dibuat di `src/content/blog/<slug>.md` dengan frontmatter terisi (`draft: true`).
   (Atau buat file `.md` / `.mdx` manual di folder yang sama.)

2. Isi kontennya (Markdown). Frontmatter yang dipakai:

   ```yaml
   ---
   title: 'Judul'
   description: 'Ringkasan 1–2 kalimat (dipakai SEO & kartu sosial)'
   category: 'Engineering' # 1 kategori utama per post (wajib)
   pubDate: 2026-06-18
   tags: ['tag-a', 'tag-b']
   draft: false # set false agar muncul saat build
   ---
   ```

3. Preview live (auto-reload):

   ```
   npm run dev      # http://localhost:4321
   ```

## Build lokal

```
npm run build      # menghasilkan folder dist/ (+ indeks pencarian dist/pagefind/)
npm run preview    # cek hasil build lokal
```

Pencarian memakai [Pagefind](https://pagefind.app): script `build` menjalankan
`pagefind --site dist` setelah `astro build`, dan yang diindeks hanya bagian bertanda
`data-pagefind-body` di `BlogPost.astro` (judul, lead, tag, isi artikel). Pengecualian
selector ada di `pagefind.yml`. Ikon kaca pembesar di nav (atau `Ctrl/⌘+K`) membuka
dialog pencarian dan baru memuat bundle Pagefind saat pertama dipakai (`Header.astro`);
halaman `/search/` tetap ada sebagai fallback tanpa JS dan untuk link `?q=`. Indeks hanya
ada setelah build, jadi di `npm run dev` ikon itu jatuh ke `/search/` yang menampilkan
pesan "index isn't available" — pakai `npm run preview`.

## Deploy otomatis (push → live) — Hostinger Git deployment

Repo: <https://github.com/afrizzal/blog>. Deployment ditangani **langsung oleh
Hostinger** (fitur *Web Apps / Node.js Apps* di hPanel): setiap **push ke
`master`**, Hostinger menarik repo, menjalankan `npm install` + `npm run build`
di servernya, lalu menyajikan isi `dist/`. Tidak ada kredensial FTP di GitHub.

### Setup di hPanel (sekali saja)

1. hPanel → **Websites → Add Website → Node.js Apps** → **Import Git Repository**.
2. Authorize **Hostinger GitHub App** → pilih repo `afrizzal/blog` + branch `master`.
3. Hostinger mendeteksi Astro otomatis. Pastikan: Build command `npm run build`,
   Output directory `dist`, Node.js `22.x` dengan patch minimal `22.23.4` (dipilih dari field
   `engines` di `package.json`).
4. Deploy, lalu **Connect domain** → arahkan `blog.afrizzal.pro` ke app ini
   (SSL terpasang otomatis).

Setelah itu alur menulis cukup:

```
./new-post.ps1 "Judul"
git add -A && git commit -m "post: judul"
git push            # <- Hostinger build & deploy otomatis
```

GitHub Actions (`.github/workflows/ci.yml`) tetap mem-build tiap push sebagai
**pemeriksa** (build rusak ketahuan di GitHub dulu). Workflow FTP lama
(`deploy.yml`) disimpan sebagai **fallback manual** (tab Actions → Run
workflow) dan boleh dihapus — beserta secrets `FTP_*` — begitu jalur Hostinger
terbukti stabil.

> Catatan: pada jalur Web Apps, situs disajikan lewat proxy Hostinger — file
> `public/.htaccess` tidak lagi dipakai (redirect HTTPS/www dan SSL ditangani
> platform). File itu tetap disertakan agar `dist/` tetap kompatibel dengan
> hosting Apache/LiteSpeed biasa (fallback FTP).

### Jika push belum terlihat di situs live

CI GitHub yang hijau membuktikan build lolos; status deployment tetap diperiksa
di hPanel → website blog → Deployments. Cocokkan commit deployment dengan HEAD
`master`, lalu baca log build bila gagal. Jika commit belum dideploy, periksa
koneksi repository/branch dan jalankan redeploy. Setelah build terbaru berhasil,
periksa HTML artikel dan URL gambarnya sebelum menyimpulkan masalah cache.

Pembaruan keamanan otomatis Hostinger hanya membuat pull request. Perubahan
dependensi baru berlaku setelah PR digabung dan deployment berikutnya berhasil.
Astro 7 menggunakan processor `unified()` agar plugin caption, tabel, dan blok
kode yang sudah ada tetap dijalankan.

## Yang sudah termasuk

- Daftar post + halaman artikel (typografi long-form, tema dark senada porto)
- Syntax highlighting (Shiki `github-dark`)
- Halaman **Categories** & **Tags** + filter per-kategori/tag, plus **pagination** di homepage (5 post/halaman)
- SEO: canonical, Open Graph, Twitter card, **JSON-LD** (`BlogPosting`)
- **RSS** (`/rss.xml`) + **sitemap** (`/sitemap-index.xml`) + `robots.txt`
- Reading-time, halaman 404

## Struktur

```
src/
  content/blog/   ← tulis post di sini (.md / .mdx)
  pages/          ← index, blog/[...slug], tags/, rss.xml, 404
  layouts/        ← BaseLayout, BlogPost
  components/     ← Header, Footer, BaseHead, PostCard, FormattedDate
  styles/         ← tokens.css (disalin dari porto), global.css
  utils/          ← posts.ts (filter draft), readingTime.ts
  consts.ts       ← judul situs, author, link sosial
public/           ← .htaccess, robots.txt, favicon.png
```

## Toolchain (Volta)

Versi Node diatur per-project oleh [Volta](https://volta.sh) — tidak mengganggu project lain:

- **Blog ini → Node 22.23.4** (di-pin di `package.json`: `"volta": { "node": "22.23.4" }`).
- **Project lain → Node 20** (default Volta).

Di terminal baru, Volta otomatis memilih versi Node sesuai folder yang sedang aktif.
Ganti versi bila perlu: `volta pin node@<versi>`.
