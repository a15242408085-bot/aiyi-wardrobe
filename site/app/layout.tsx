import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "爱衣橱 · 在线体验",
  description: "整理你的衣物，识别搭配图片，生成真人模特试穿效果。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
