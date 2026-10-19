import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { Workbench } from '@/components/aiyi/workbench';

vi.mock('next-auth/react', () => ({
  useSession: () => ({data: {accessToken: 'test-token', user: {id: 'test-user'}}, status: 'authenticated'}),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('@/components/aiyi/ai-workflows', () => ({AISettings: () => null, FittingPanel: () => null, RecognitionPanel: () => null}));
vi.mock('@/components/aiyi/catalog-studio', () => ({CatalogStudio: () => null}));

afterEach(() => {cleanup(); vi.restoreAllMocks();});

it('counts, filters and edits a recognized top with the same Chinese category', async () => {
  const item = {id: 'recognized-top', name: '深蓝色丝绒短袖', type: 'top', primary_color: 'navy', favorite: false, notes: null, image_url: '/top.png'};
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const payload = url.includes('/items?') ? {items: [item], total: 1, has_more: false}
      : url.endsWith('/health/ready') ? {status: 'healthy', checks: {database: 'healthy'}}
      : url.endsWith('/capabilities') ? {ai: {vision: true, text: false}}
      : init?.method === 'PATCH' ? item : {};
    return new Response(JSON.stringify(payload), {status: 200, headers: {'Content-Type': 'application/json'}});
  });
  const client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: 0}, mutations: {retry: false}}});
  render(<QueryClientProvider client={client}><Workbench section="wardrobe"/></QueryClientProvider>);
  const heading = await screen.findByRole('heading', {name: item.name});
  const card = heading.closest('article')!;
  expect(within(card).getByText('上衣', {exact: false})).toHaveTextContent('上衣·藏蓝');
  const topSummary = screen.getAllByText('上衣', {exact: true}).find(element => element.tagName === 'SPAN')!;
  expect(topSummary.parentElement).toHaveTextContent('1上衣');
  fireEvent.click(screen.getByRole('button', {name: '上衣'}));
  expect(screen.getByRole('heading', {name: item.name})).toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox', {name: '搜索衣物'}), {target: {value: '上衣'}});
  expect(screen.getByRole('heading', {name: item.name})).toBeInTheDocument();
  fireEvent.click(within(card).getByRole('button', {name: '编辑'}));
  const dialog = screen.getByRole('dialog', {name: '编辑衣物'});
  expect(within(dialog).getByRole('combobox', {name: '类别'})).toHaveValue('top');
  expect(within(dialog).getByRole('combobox', {name: '类别'})).toHaveDisplayValue('上衣');
  fireEvent.click(within(dialog).getByRole('button', {name: '保存衣物'}));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/v1/items/recognized-top', expect.objectContaining({method: 'PATCH'})));
  const saved = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
  expect(JSON.parse(saved[1]!.body as string).type).toBe('top');
  await screen.findByText('衣物已保存到你的衣橱。');
  client.clear();
});
