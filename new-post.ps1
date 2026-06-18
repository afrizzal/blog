# new-post.ps1 — buat draft post baru untuk blog
# Usage:  .\new-post.ps1 "Judul Post Saya"
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Title
)

# slugify: lowercase, non-alfanumerik -> '-', rapikan tanda '-' di ujung
$slug = $Title.ToLower()
$slug = $slug -replace '[^a-z0-9]+', '-'
$slug = $slug.Trim('-')
if ([string]::IsNullOrWhiteSpace($slug)) {
  Write-Host "Judul tidak valid (tidak ada karakter alfanumerik)." -ForegroundColor Red
  exit 1
}

$dir  = Join-Path $PSScriptRoot 'src\content\blog'
$file = Join-Path $dir "$slug.md"
if (Test-Path $file) {
  Write-Host "Sudah ada: $file" -ForegroundColor Yellow
  exit 1
}

$date = Get-Date -Format 'yyyy-MM-dd'
$tEsc = $Title -replace "'", "''"   # escape kutip tunggal untuk YAML

$body = @"
---
title: '$tEsc'
description: ''
category: 'Notes'
pubDate: $date
tags: []
draft: true
---

Tulis di sini...
"@

[System.IO.File]::WriteAllText($file, $body, (New-Object System.Text.UTF8Encoding $false))
Write-Host "Dibuat: $file" -ForegroundColor Green
Write-Host "Edit deskripsi + tags, set draft: false saat siap terbit." -ForegroundColor Gray
Write-Host "Preview: npm run dev  ->  http://localhost:4321" -ForegroundColor Cyan
