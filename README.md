# blog.afrizzal.pro

Blog pribadi Afrizzal — **Astro 6 (static)**. Hasil build = HTML statis biasa, jadi bisa
di-host di shared hosting apa pun. **Tidak butuh PHP/MySQL saat runtime.**

> Catatan SEO: blog ini sengaja **tidak** memakai trik base64/anti-devtools seperti porto,
> supaya artikel bisa dibaca (di-crawl) oleh Google.

## Prasyarat

- **Volta** mengatur versi Node otomatis per-project (sudah terpasang).
- Folder blog ini di-**pin ke Node 22** (lihat field `"volta"` di `package.json`); project lain tetap Node 20 (default Volta). Tidak perlu switch manual — cukup `cd` ke folder ini.

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
npm run build      # menghasilkan folder dist/
npm run preview    # cek hasil build lokal
```

## Deploy otomatis (push → live) — Hostinger Git deployment

Repo: <https://github.com/afrizzal/blog>. Deployment ditangani **langsung oleh
Hostinger** (fitur *Web Apps / Node.js Apps* di hPanel): setiap **push ke
`master`**, Hostinger menarik repo, menjalankan `npm install` + `npm run build`
di servernya, lalu menyajikan isi `dist/`. Tidak ada kredensial FTP di GitHub.

### Setup di hPanel (sekali saja)

1. hPanel → **Websites → Add Website → Node.js Apps** → **Import Git Repository**.
2. Authorize **Hostinger GitHub App** → pilih repo `afrizzal/blog` + branch `master`.
3. Hostinger mendeteksi Astro otomatis. Pastikan: Build command `npm run build`,
   Output directory `dist`, Node.js `22.x` (dipilih otomatis dari field
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

- **Blog ini → Node 22** (di-pin di `package.json`: `"volta": { "node": "22.x" }`).
- **Project lain → Node 20** (default Volta).

Di terminal baru, Volta otomatis memilih versi Node sesuai folder yang sedang aktif.
Ganti versi bila perlu: `volta pin node@<versi>`.
