import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '爱衣橱 · 每一套，都有自己的样子',
  description: '整理自己的衣橱，搭配喜欢的单品，看看真实的试穿与转身效果。',
};

export default function WorkspaceLayout({children}: {children: React.ReactNode}) {
  return <>{children}</>;
}
