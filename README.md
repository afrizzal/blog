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

## Build & deploy

```
npm run build      # menghasilkan folder dist/
npm run preview    # cek hasil build lokal sebelum upload
```

Lalu upload **isi folder `dist/`** (bukan foldernya) ke document root subdomain
`blog.afrizzal.pro` lewat cPanel File Manager / FTP.

### Setup subdomain di cPanel (sekali saja)

1. cPanel → **Subdomains** → buat `blog` di domain `afrizzal.pro`.
2. Arahkan **Document Root** ke folder upload (mis. `/home/USER/blog.afrizzal.pro`).
3. Aktifkan SSL (AutoSSL / Let's Encrypt) untuk subdomain itu.
4. Upload isi `dist/` ke document root tersebut.

`.htaccess` (force HTTPS + www→non-www + halaman 404) sudah ikut ter-build dari
`public/.htaccess`.

## Deploy otomatis (push → live)

Repo: <https://github.com/afrizzal/aff-blog>. Setiap **push ke `master`**, GitHub Actions
(`.github/workflows/deploy.yml`) otomatis: build Astro (Node 22) → upload `dist/` via **FTPS**
ke document root `blog.afrizzal.pro`. Jadi alur menulis cukup:

```
./new-post.ps1 "Judul"
git add -A && git commit -m "post: judul"
git push            # <- langsung ter-deploy
```

### Secret yang harus diisi sekali (repo → Settings → Secrets and variables → Actions)

| Secret | Isi |
|---|---|
| `FTP_HOST` | host FTP (mis. `ftp.afrizzal.pro` atau IP server) |
| `FTP_USERNAME` | user FTP (cPanel → FTP Accounts) |
| `FTP_PASSWORD` | password FTP |
| `FTP_SERVER_DIR` | Document Root subdomain, **diakhiri `/`** (mis. `/blog.afrizzal.pro/`) |

Atau lewat CLI (nilai tidak tersimpan di chat):

```
gh secret set FTP_HOST
gh secret set FTP_USERNAME
gh secret set FTP_PASSWORD
gh secret set FTP_SERVER_DIR
```

Run pertama tanpa secret akan gagal di langkah FTP (build tetap sukses) — itu wajar.
Setelah secret terisi: `git push` lagi, atau buka tab **Actions → Run workflow**.

> Jika host tidak mendukung FTPS, ubah `protocol: ftps` → `ftp` di `deploy.yml`.

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
