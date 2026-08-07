// Pass-through : le <html lang> est possédé par src/app/[locale]/layout.tsx
// (pattern VidiaFlow prouvé sur Next 16.2 — laisse les metadata routes
// vivre hors préfixe locale sans dupliquer le document).
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return children;
}
