import "./globals.css";
import { ReactNode } from "react";
import Link from "next/link";

export const metadata = {
  title: "Optyx Console",
  description: "AI Gateway + Optimization Console MVP"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="app-shell">
          <header className="top-nav">
            <Link href="/" className="logo">
              Optyx
            </Link>
            <nav className="nav-links">
              <Link href="/projects">Projects</Link>
              <Link href="/logs">Logs</Link>
              <Link href="http://localhost:4000/health" target="_blank">
                Gateway Health
              </Link>
            </nav>
          </header>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
