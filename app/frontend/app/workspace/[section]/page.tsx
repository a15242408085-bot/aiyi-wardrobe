import { notFound } from 'next/navigation';
import { Workbench, type Section } from '@/components/aiyi/workbench';

const sections: Section[] = ['wardrobe', 'outfits', 'fitting', 'models', 'body', 'settings'];

export default function WorkspacePage({ params }: { params: { section: string } }) {
  // The passwordless workspace is deliberately unavailable unless the local launcher enables it.
  if (process.env.AIYI_LOCAL_WORKSPACE !== 'true' || !sections.includes(params.section as Section)) notFound();
  return <Workbench section={params.section as Section} />;
}
