import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AISettings, FittingPanel, RecognitionPanel, type AIRequest } from '@/components/aiyi/ai-workflows';

const config = {configured: true, provider: 'openai', base_url: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', quality: 'low', key_source: 'saved'};
const settings = {recognition: config, image: {...config, model: 'gpt-image-2'}, rotation: {...config, configured: false, provider: 'wavespeed', model: 'bytedance/seedance-2.0/image-to-video', key_source: 'none'}};
const emptyPage = {jobs: [], total: 0, has_more: false, next_offset: null};
const emptyKinds = (path: string) => path.includes('kind=model') || path.includes('kind=rotation');
function mount(ui: React.ReactNode) {
  const client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: 0}, mutations: {retry: false}}});
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}
beforeEach(() => {URL.createObjectURL = vi.fn(() => 'blob:test-preview'); URL.revokeObjectURL = vi.fn();});
afterEach(cleanup);

describe('AI workbench workflows', () => {
  it('keeps AI submission disabled when no API is configured', async () => {
    const request = vi.fn(async (path: string) => path === '/ai/services' ? {...settings, recognition: {...config, configured: false, key_source: 'none'}} : {jobs: []});
    mount(<RecognitionPanel request={request as AIRequest} userKey="user-1"/>);
    await screen.findByText('衣物识别服务尚未配置');
    fireEvent.change(screen.getByLabelText('选择待识别的衣物照片'), {target: {files: [new File(['image'], 'shirt.png', {type: 'image/png'})]}});
    expect(screen.getByRole('button', {name: '开始识别'})).toBeDisabled();
    expect(request.mock.calls.some(([path]) => path === '/ai/recognitions')).toBe(false);
  });

  it('requires confirmation and saves only the selected, edited recognition candidates', async () => {
    const candidate = {candidate_id: 'c1', name: '白色上衣', type: 'top', colors: ['white'], primary_color: 'white', season: ['summer'], material: 'cotton', notes: null, image_url: '/shirt.png'};
    const job = {id: 'recognition-1', kind: 'recognition', status: 'awaiting_confirmation', stage: 'ready', progress: 100, source_image_url: '/source.png', created_at: '2026-10-15T10:00:00Z', updated_at: '2026-10-15T10:00:00Z', result: {candidates: [candidate, {...candidate, candidate_id: 'c2', name: '蓝色运动鞋', type: 'sneakers'}]}};
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/ai/services') return settings;
      if (emptyKinds(path)) return emptyPage;
      if (init?.method === 'POST') return {...job, status: 'completed', result: {item_ids: ['saved-1']}};
      return {jobs: [job]};
    });
    mount(<RecognitionPanel request={request as AIRequest} userKey="user-1"/>);
    await screen.findByText('等待你确认');
    expect(request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(screen.getAllByRole('combobox', {name: '类别'})[0]).toHaveValue('top');
    expect(screen.getAllByRole('combobox', {name: '类别'})[0]).toHaveDisplayValue('上衣');
    expect(screen.getAllByRole('combobox', {name: '类别'})[1]).toHaveValue('sneakers');
    expect(screen.getAllByRole('combobox', {name: '类别'})[1]).toHaveDisplayValue('运动鞋');
    fireEvent.change(screen.getByLabelText('衣物名称 c1'), {target: {value: '我的白色纯棉上衣'}});
    fireEvent.change(screen.getAllByRole('combobox', {name: '类别'})[0], {target: {value: 'accessories'}});
    expect(screen.queryByRole('option', {name: 'unknown'})).toBeNull();
    fireEvent.click(screen.getAllByRole('checkbox', {name: '保存这件'})[1]);
    fireEvent.click(screen.getByRole('button', {name: '确认入库 1 件'}));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/ai/recognitions/recognition-1/confirm', expect.any(Object)));
    const payload = JSON.parse(request.mock.calls.find(([path]) => path.endsWith('/confirm'))![1]!.body as string);
    expect(payload.candidates).toHaveLength(1);
    expect(payload.candidates[0]).toMatchObject({candidate_id: 'c1', name: '我的白色纯棉上衣', type: 'accessories'});
    expect(payload.candidates[0]).not.toHaveProperty('image_url');
  });

  it('selects all five categories including a bag, replaces same-category items and submits the chosen IDs', async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => path === '/ai/services' ? settings : emptyKinds(path) ? emptyPage : init?.method === 'POST' ? {id: 'try-1'} : {jobs: []});
    const items = [
      {id: 'shirt-1', name: '第一件上衣', type: 't-shirt', image_url: '/a.png'},
      {id: 'shirt-2', name: '第二件上衣', type: 'top', image_url: '/b.png'},
      {id: 'pants-1', name: '蓝色裤子', type: 'pants', image_url: '/c.png'},
      {id: 'jacket-1', name: '浅色外套', type: 'jacket', image_url: '/jacket.png'},
      {id: 'shoes-1', name: '白色鞋子', type: 'sneakers', image_url: '/shoes.png'},
      {id: 'bag-1', name: '手提包', type: 'bag', image_url: '/d.png'},
      {id: 'bag-2', name: '单肩包', type: 'bag', image_url: '/bag-2.png'},
      {id: 'dress-1', name: '连衣裙', type: 'dress', image_url: '/dress.png'},
    ];
    mount(<FittingPanel request={request as AIRequest} userKey="user-1" items={items} itemsLoading={false} retryItems={() => {}}/>);
    const photo = new File(['person-photo'], 'person.png', {type: 'image/png'});
    fireEvent.change(screen.getByLabelText('上传人物全身照'), {target: {files: [photo]}});
    fireEvent.click(screen.getByRole('button', {name: /第一件上衣/}));
    fireEvent.click(screen.getByRole('button', {name: /第二件上衣/}));
    fireEvent.click(screen.getByRole('button', {name: /蓝色裤子/}));
    fireEvent.click(screen.getByRole('button', {name: /浅色外套/}));
    fireEvent.click(screen.getByRole('button', {name: /白色鞋子/}));
    fireEvent.click(screen.getByRole('button', {name: /手提包/}));
    expect(screen.getByText('5 / 5')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name: /单肩包/}));
    expect(screen.getByRole('button', {name: /手提包/})).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', {name: /单肩包/})).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('5 / 5')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name: /单肩包/}));
    expect(screen.getByText('4 / 5')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name: /手提包/}));
    expect(screen.getByRole('button', {name: /第一件上衣/})).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('button', {name: /连衣裙/})).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', {name: '生成试穿图 · 5 件衣物'})).toBeEnabled());
    fireEvent.click(screen.getByRole('button', {name: '生成试穿图 · 5 件衣物'}));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/ai/try-ons', expect.any(Object)));
    const form = request.mock.calls.find(([path]) => path === '/ai/try-ons')![1]!.body as FormData;
    expect(form.get('person_image')).toBe(photo);
    expect(JSON.parse(form.get('item_ids') as string)).toEqual(['shirt-2', 'pants-1', 'jacket-1', 'shoes-1', 'bag-1']);
  });

  it('restores completed try-on results from the server without resubmitting', async () => {
    const job = {id: 'saved-try-on', kind: 'try_on', status: 'completed', stage: '生成完成', progress: 100, source_image_url: '/person.jpg', created_at: '2026-10-15T10:00:00Z', updated_at: '2026-10-15T10:00:00Z', result: {image_url: '/generated.png', item_ids: ['shirt-1']}};
    const request = vi.fn(async (path: string, _init?: RequestInit) => path === '/ai/services' ? settings : emptyKinds(path) ? emptyPage : {jobs: [job]});
    mount(<FittingPanel request={request as AIRequest} userKey="user-1" items={[]} itemsLoading={false} retryItems={() => {}}/>);
    expect(await screen.findByAltText('AI 生成的试穿结果')).toHaveAttribute('src', '/generated.png');
    expect(screen.getByRole('link', {name: '下载试穿图'})).toHaveAttribute('href', '/generated.png');
    expect(screen.getByRole('link', {name: '下载试穿图'})).toHaveAttribute('download', '爱衣橱-试穿-saved-try-on.jpg');
    expect(request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('loads older recognition candidates beyond the first page', async () => {
    const base = {kind: 'recognition', status: 'completed', stage: '已入库', progress: 100, source_image_url: '/source.png', created_at: '2026-10-15T10:00:00Z', updated_at: '2026-10-15T10:00:00Z', result: {item_ids: ['saved-1']}};
    const olderJob = {...base, id: 'older-candidate-job', status: 'awaiting_confirmation', result: {candidates: [{candidate_id: 'old-candidate', name: '待确认的旧衣物', type: 'shirt', colors: [], primary_color: null, season: [], material: null, notes: null, image_url: '/old.png'}]}};
    const request = vi.fn(async (path: string) => {
      if (path === '/ai/services') return settings;
      if (emptyKinds(path)) return emptyPage;
      return path.includes('offset=30') ? {jobs: [olderJob], total: 31, has_more: false, next_offset: null} : {jobs: Array.from({length: 30}, (_, index) => ({...base, id: `recent-${index}`})), total: 31, has_more: true, next_offset: 30};
    });
    mount(<RecognitionPanel request={request as AIRequest} userKey="user-1"/>);
    fireEvent.click(await screen.findByRole('button', {name: '加载更多识别任务'}));
    expect(await screen.findByLabelText('衣物名称 old-candidate')).toHaveValue('待确认的旧衣物');
    expect(request).toHaveBeenCalledWith('/ai/jobs?kind=recognition&offset=30&limit=30');
    expect(screen.getByText('已显示 31 / 31 条任务')).toBeInTheDocument();
    expect(screen.queryByRole('button', {name: '加载更多识别任务'})).toBeNull();
  });

  it('polls an active task loaded from an older page and retains its completed result', async () => {
    const base = {kind: 'try_on', status: 'completed', stage: '生成完成', progress: 100, source_image_url: '/person.jpg', created_at: '2026-10-15T10:00:00Z', updated_at: '2026-10-15T10:00:00Z', result: {item_ids: ['shirt-1']}};
    let olderCalls = 0;
    const request = vi.fn(async (path: string) => {
      if (path === '/ai/services') return settings;
      if (emptyKinds(path)) return emptyPage;
      if (path.includes('offset=30')) {
        olderCalls += 1;
        return {jobs: [{...base, id: 'older-active', status: olderCalls === 1 ? 'running' : 'completed', stage: '旧任务处理中', result: olderCalls === 1 ? {} : {image_url: '/old-result.png'}}], total: 31, has_more: false, next_offset: null};
      }
      return {jobs: Array.from({length: 30}, (_, index) => ({...base, id: `recent-${index}`})), total: 31, has_more: true, next_offset: 30};
    });
    mount(<FittingPanel request={request as AIRequest} userKey="user-1" items={[]} itemsLoading={false} retryItems={() => {}}/>);
    fireEvent.click(await screen.findByRole('button', {name: '加载更多试穿记录'}));
    expect(await screen.findByText('旧任务处理中 · 100%')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByAltText('AI 生成的试穿结果')).toHaveAttribute('src', '/old-result.png'), {timeout: 4500});
    expect(olderCalls).toBeGreaterThan(1);
    expect(screen.getByText('已显示 31 / 31 条任务')).toBeInTheDocument();
  });

  it('isolates paged job history when the current user changes', async () => {
    const base = {id: 'history', kind: 'try_on', status: 'completed', stage: '生成完成', progress: 100, source_image_url: '/person.jpg', created_at: '2026-10-15T10:00:00Z', updated_at: '2026-10-15T10:00:00Z'};
    const userA = vi.fn(async (path: string) => path === '/ai/services' ? settings : emptyKinds(path) ? emptyPage : {jobs: [{...base, result: {image_url: '/user-a.png'}}], total: 1, has_more: false, next_offset: null});
    const userB = vi.fn(async (path: string) => path === '/ai/services' ? settings : emptyKinds(path) ? emptyPage : {jobs: [{...base, result: {image_url: '/user-b.png'}}], total: 1, has_more: false, next_offset: null});
    const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
    const {rerender} = render(<QueryClientProvider client={client}><FittingPanel request={userA as AIRequest} userKey="user-a" items={[]} itemsLoading={false} retryItems={() => {}}/></QueryClientProvider>);
    expect(await screen.findByAltText('AI 生成的试穿结果')).toHaveAttribute('src', '/user-a.png');
    rerender(<QueryClientProvider client={client}><FittingPanel request={userB as AIRequest} userKey="user-b" items={[]} itemsLoading={false} retryItems={() => {}}/></QueryClientProvider>);
    await waitFor(() => expect(screen.getByAltText('AI 生成的试穿结果')).toHaveAttribute('src', '/user-b.png'));
    expect(userB).toHaveBeenCalledWith('/ai/jobs?kind=try_on&offset=0&limit=30');
    expect(screen.queryByRole('img', {name: 'AI 生成的试穿结果'})).not.toHaveAttribute('src', '/user-a.png');
    client.clear();
  });

  it('reports each service model check independently without implying inference passed', async () => {
    const request = vi.fn(async (path: string, _init?: RequestInit) => path.endsWith('/check')
      ? {status: 'connected', message: 'API 已连通。', model_listed: path.includes('/image/')}
      : settings);
    mount(<AISettings request={request as AIRequest} userKey="user-1"/>);
    const recognitionCard = await screen.findByRole('region', {name: '衣物识别服务配置'});
    const imageCard = screen.getByRole('region', {name: '单品图与试穿服务配置'});
    fireEvent.click(within(recognitionCard).getByRole('button', {name: '检查已保存配置'}));
    expect(await within(recognitionCard).findByText('模型（gpt-4.1-mini）：未在模型列表中列出，请核对模型名或访问权限。')).toBeInTheDocument();
    fireEvent.click(within(imageCard).getByRole('button', {name: '检查已保存配置'}));
    expect(await within(imageCard).findByText('模型（gpt-image-2）：已在服务返回的模型列表中列出。')).toBeInTheDocument();
    expect(within(imageCard).getByText('连通或列出模型不代表实际生成已经通过，仍需提交真实图片验证。')).toBeInTheDocument();
    expect(screen.getByText(/可以先配置图片服务验证试穿/)).toBeInTheDocument();
    expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toEqual([['/ai/services/recognition/check', {method: 'POST'}], ['/ai/services/image/check', {method: 'POST'}]]);
  });

  it('offers DeepSeek only for recognition and saves its provider-specific defaults', async () => {
    const deepseek = {...config, configured: false, provider: 'deepseek', base_url: 'https://api.deepseek.com', model: 'deepseek-flash', key_source: 'none'};
    const request = vi.fn(async (_path: string, init?: RequestInit) => init?.method === 'PUT' ? deepseek : settings);
    mount(<AISettings request={request as AIRequest} userKey="user-1"/>);
    const recognitionCard = await screen.findByRole('region', {name: '衣物识别服务配置'});
    const imageCard = screen.getByRole('region', {name: '单品图与试穿服务配置'});
    const rotationCard = screen.getByRole('region', {name: '360 视频服务配置'});
    expect(within(recognitionCard).getByRole('option', {name: 'DeepSeek 衣物识别'})).toBeInTheDocument();
    expect(within(imageCard).queryByRole('option', {name: 'DeepSeek 衣物识别'})).toBeNull();
    expect(within(rotationCard).queryByRole('option', {name: 'DeepSeek 衣物识别'})).toBeNull();
    fireEvent.change(within(recognitionCard).getByRole('combobox', {name: '服务类型'}), {target: {value: 'deepseek'}});
    expect(within(recognitionCard).getByLabelText('API 地址')).toHaveValue('https://api.deepseek.com');
    expect(within(recognitionCard).getByLabelText('模型名称')).toHaveValue('deepseek-flash');
    expect(within(imageCard).getByLabelText('模型名称')).toHaveValue('gpt-image-2');
    fireEvent.click(within(recognitionCard).getByRole('button', {name: '保存服务配置'}));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/ai/services/recognition', expect.objectContaining({method: 'PUT'})));
    const saved = request.mock.calls.find(([, init]) => init?.method === 'PUT')!;
    expect(JSON.parse(saved[1]!.body as string)).toEqual({provider: 'deepseek', base_url: 'https://api.deepseek.com', model: 'deepseek-flash', quality: 'low'});
  });

  it('clears the key after saving and never stores it in browser storage', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const request = vi.fn(async (_path: string, init?: RequestInit) => init?.method === 'PUT' ? settings.image : settings);
    mount(<AISettings request={request as AIRequest} userKey="user-1"/>);
    const input = await screen.findByLabelText('单品图与试穿 API 密钥');
    fireEvent.change(input, {target: {value: 'test-only-secret'}});
    fireEvent.click(within(screen.getByRole('region', {name: '单品图与试穿服务配置'})).getByRole('button', {name: '保存服务配置'}));
    await waitFor(() => expect(input).toHaveValue(''));
    const saved = request.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(saved![1]!.body as string).api_key).toBe('test-only-secret');
    expect(storage).not.toHaveBeenCalled();
    storage.mockRestore();
  });
});
