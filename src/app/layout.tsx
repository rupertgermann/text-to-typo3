import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";
import Script from "next/script";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "text-to-typo3",
  description: "AI-powered chat interface for TYPO3 CMS",
};

const THEME_STORAGE_KEY = "text-to-typo3-theme";
const THEME_COOKIE_KEY = "text-to-typo3-theme";

const themeInitScript = `
  (function() {
    try {
      var key = '${THEME_STORAGE_KEY}';
      var stored = localStorage.getItem(key);
      var theme = stored === 'light' || stored === 'dark'
        ? stored
        : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      document.documentElement.classList.toggle('dark', theme === 'dark');
      document.documentElement.style.colorScheme = theme;
      document.cookie = '${THEME_COOKIE_KEY}=' + theme + '; path=/; max-age=31536000; samesite=lax';
    } catch (error) {}
  })();
`;

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const storedTheme = (await cookies()).get(THEME_COOKIE_KEY)?.value;
  const initialTheme = storedTheme === "dark" ? "dark" : "light";

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${initialTheme === "dark" ? "dark " : ""}h-full antialiased`}
      style={{ colorScheme: initialTheme }}
    >
      <head>
        <Script id="theme-init" strategy="beforeInteractive">
          {themeInitScript}
        </Script>
      </head>
      <body className="min-h-full flex flex-col">
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
