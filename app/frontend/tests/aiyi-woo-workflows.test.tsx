import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecognitionPanel, FittingPanel } from '@/components/aiyi/ai-workflows';
import { ModelsPanel, RotationAction } from '@/components/aiyi/model-rotation';
import { CatalogStudio } from '@/components/aiyi/catalog-studio';
import { RotationViewer } from '@/components/aiyi/rotation-viewer';
import { AIRequest } from '@/components/aiyi/ai-common';

const config = {configured: false, provider: 'openai', base_url: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', quality: 'low', key_source: 'none'};
const services = {recognition: config, image: {...config, model: 'gpt-image-2'}, rotation: {...config, provider: 'wavespeed', model: 'bytedance/seedance-2.0/image-to-video'}};
const emptyPage = {jobs: [], total: 0, has_more: false, next_offset: null};
const baseJob = {status: 'completed', stage: '已完成', progress: 100, source_image_url: '/user-source.jpg', created_at: '2026-10-16T00:00:00Z', updated_at: '2026-10-16T00:00:00Z'};
function mount(ui: React.ReactNode) {const client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: 0}, mutations: {retry: false}}}); return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);}
beforeEach(() => {URL.createObjectURL = vi.fn(() => 'blob:user-file'); URL.revokeObjectURL = vi.fn();});
afterEach(() => {cleanup(); vi.useRealTimers();});

describe('WOO-inspired local workflows', () => {
  it('allows recognition alone and sends the optional product-image choice explicitly', async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => path === '/ai/services' ? {...services, recognition: {...config, configured: true}} : init?.method === 'POST' ? {id: 'recognition'} : emptyPage);
    mount(<RecognitionPanel request={request as AIRequest} userKey="user"/>);
    fireEvent.change(screen.getByLabelText('选择待识别的衣物照片'), {target: {files: [new File(['image'], 'shirt.png', {type: 'image/png'})]}});
    await waitFor(() => expect(screen.getByRole('button', {name: '开始识别'})).toBeEnabled());
    expect(screen.getByRole('checkbox', {name: '同时生成干净单品图'})).toBeDisabled();
    fireEvent.click(screen.getByRole('button', {name: '开始识别'}));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/ai/recognitions', expect.any(Object)));
    const body = request.mock.calls.find(([path]) => path === '/ai/recognitions')![1]!.body as FormData;
    expect(body.get('generate_product_images')).toBe('false');
  });

  it('opts into separate product-image generation only when the image service is ready', async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => path === '/ai/services' ? {...services, recognition: {...config, configured: true}, image: {...config, configured: true}} : init?.method === 'POST' ? {id: 'recognition'} : emptyPage);
    mount(<RecognitionPanel request={request as AIRequest} userKey="user"/>);
    await waitFor(() => expect(screen.getByRole('checkbox', {name: '同时生成干净单品图'})).toBeEnabled());
    fireEvent.click(screen.getByRole('checkbox', {name: '同时生成干净单品图'}));
    expect(screen.getByText(/每类最多保留一件/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('选择待识别的衣物照片'), {target: {files: [new File(['image'], 'shirt.png', {type: 'image/png'})]}});
    fireEvent.click(screen.getByRole('button', {name: '开始识别'}));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/ai/recognitions', expect.any(Object)));
    expect((request.mock.calls.find(([path]) => path === '/ai/recognitions')![1]!.body as FormData).get('generate_product_images')).toBe('true');
  });

  it('saves an actual model photo locally without a configured cloud service', async () => {
    let saved = false;
    const model = {...baseJob, id: 'model-1', kind: 'model', result: {name: '我的全身照', image_url: '/saved-person.png'}};
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/ai/services') return services;
      if (path === '/ai/models' && init?.method === 'POST') {saved = true; return model;}
      return path.includes('kind=model') && saved ? {jobs: [model], total: 1, has_more: false, next_offset: null} : emptyPage;
    });
    mount(<ModelsPanel request={request as AIRequest} userKey="user"/>);
    const photo = new File(['person'], 'person.png', {type: 'image/png'});
    fireEvent.change(screen.getByLabelText('选择模特人物照片'), {target: {files: [photo]}});
    fireEvent.change(screen.getByLabelText('模特名称'), {target: {value: '我的全身照'}});
    fireEvent.click(screen.getByRole('button', {name: '保存模特'}));
    expect(await screen.findByRole('link', {name: '用这个模特试穿'})).toHaveAttribute('href', '/workspace/fitting?model=model-1');
    const body = request.mock.calls.find(([path]) => path === '/ai/models')![1]!.body as FormData;
    expect(body.get('image')).toBe(photo); expect(body.get('name')).toBe('我的全身照');
  });

  it('imports a user video locally with green removal off by default', async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => path === '/ai/services' ? services : init?.method === 'POST' ? {id: 'rotation-1'} : emptyPage);
    mount(<ModelsPanel request={request as AIRequest} userKey="user"/>);
    const video = new File(['video'], 'turn.mp4', {type: 'video/mp4'});
    fireEvent.change(screen.getByLabelText('选择转身视频'), {target: {files: [video]}});
    fireEvent.change(screen.getByLabelText('转身展示名称'), {target: {value: '自己的转身视频'}});
    fireEvent.click(screen.getByRole('button', {name: '导入并生成转身展示'}));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/ai/rotations/import', expect.any(Object)));
    const body = request.mock.calls.find(([path]) => path === '/ai/rotations/import')![1]!.body as FormData;
    expect(body.get('video')).toBe(video); expect(body.get('remove_green')).toBe('false');
    expect(body.get('name')).toBe('自己的转身视频');
  });

  it('uses a stored model ID instead of uploading another person image for try-on', async () => {
    const model = {...baseJob, id: 'model-1', kind: 'model', result: {name: '自己的模特', image_url: '/model.png'}};
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/ai/services') return {...services, image: {...config, configured: true}};
      if (init?.method === 'POST') return {id: 'try-on'};
      return path.includes('kind=model') ? {jobs: [model], total: 1, has_more: false, next_offset: null} : emptyPage;
    });
    mount(<FittingPanel request={request as AIRequest} userKey="user" items={[{id: 'shirt-1', name: '白衬衫', type: 'shirt', image_url: '/shirt.png'}]} itemsLoading={false} retryItems={() => {}}/>);
    fireEvent.click(screen.getByRole('button', {name: '从模特库选择'}));
    await screen.findByRole('option', {name: '自己的模特'});
    fireEvent.change(screen.getByRole('combobox', {name: '选择已保存模特'}), {target: {value: 'model-1'}});
    fireEvent.click(screen.getByRole('button', {name: /白衬衫/}));
    fireEvent.click(screen.getByRole('button', {name: '生成试穿图 · 1 件衣物'}));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/ai/try-ons', expect.any(Object)));
    const body = request.mock.calls.find(([path]) => path === '/ai/try-ons')![1]!.body as FormData;
    expect(body.get('model_id')).toBe('model-1'); expect(body.has('person_image')).toBe(false);
  });

  it('does not replace an item image until the generated catalog image is confirmed', async () => {
    let applied = false;
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/ai/services') return {...services, image: {...config, configured: true}};
      if (path.endsWith('/apply') && init?.method === 'POST') applied = true;
      const job = {...baseJob, id: 'catalog-1', kind: 'catalog', result: {image_url: '/clean-shirt.png', item_id: 'shirt-1', applied}};
      return path.endsWith('/apply') ? job : {jobs: [job], total: 1, has_more: false, next_offset: null};
    });
    mount(<CatalogStudio request={request as AIRequest} userKey="user" items={[{id: 'shirt-1', name: '白衬衫', type: 'shirt', image_url: '/shirt.png'}]}/>);
    await screen.findByAltText('生成的干净单品图');
    expect(request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    fireEvent.click(screen.getByRole('button', {name: '确认使用这张单品图'}));
    expect(await screen.findByText('已应用为衣橱主图')).toBeInTheDocument();
    expect(request).toHaveBeenCalledWith('/ai/catalog-images/catalog-1/apply', {method: 'POST'});
  });

  it('enables 360 generation only for the separate rotation service and preserves the source job', async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => path === '/ai/services' ? {...services, image: {...config, configured: true}, rotation: {...services.rotation, configured: true}} : {id: 'rotation-1'});
    mount(<RotationAction request={request as AIRequest} userKey="user" sourceJobId="try-on-source"/>);
    await waitFor(() => expect(screen.getByRole('button', {name: '生成 360 转身'})).toBeEnabled());
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', {name: '生成 360 转身'}));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/ai/rotations', expect.any(Object)));
    const body = request.mock.calls.find(([path]) => path === '/ai/rotations')![1]!.body as FormData;
    expect(body.get('source_job_id')).toBe('try-on-source'); expect(body.get('remove_green')).toBe('false');
  });
});

describe('actual rotation frame viewer', () => {
  const frames = Array.from({length: 61}, (_, index) => `/actual-frames/${index}.png`);
  it('selects real frame URLs with the slider and wraps both directions', () => {
    render(<RotationViewer frames={frames} name="我的转身"/>);
    expect(screen.getByRole('img')).toHaveAttribute('src', frames[0]);
    fireEvent.change(screen.getByRole('slider', {name: '转身帧位置'}), {target: {value: '30'}});
    expect(screen.getByRole('img')).toHaveAttribute('src', frames[30]);
    fireEvent.change(screen.getByRole('slider'), {target: {value: '0'}});
    fireEvent.click(screen.getByRole('button', {name: '上一帧'}));
    expect(screen.getByRole('img')).toHaveAttribute('src', frames[60]);
    fireEvent.click(screen.getByRole('button', {name: '下一帧'}));
    expect(screen.getByRole('img')).toHaveAttribute('src', frames[0]);
  });

  it('drags through frames even beyond one full turn without a negative index', () => {
    vi.stubGlobal('PointerEvent', MouseEvent);
    render(<RotationViewer frames={frames} name="我的转身"/>);
    const stage = screen.getByLabelText('我的转身转身画面');
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({width: 610} as DOMRect);
    fireEvent.pointerDown(stage, {button: 0, clientX: 0});
    fireEvent.pointerMove(stage, {clientX: 180});
    expect(screen.getByRole('img')).toHaveAttribute('src', frames[18]);
    fireEvent.pointerMove(stage, {clientX: -1300});
    expect(screen.getByRole('img')).toHaveAttribute('src', frames[53]);
    fireEvent.pointerUp(stage);
    fireEvent.pointerMove(stage, {clientX: 300});
    expect(screen.getByRole('img')).toHaveAttribute('src', frames[53]);
    vi.unstubAllGlobals();
  });

  it('plays actual frames and stops advancing after pause', () => {
    vi.useFakeTimers();
    render(<RotationViewer frames={frames} name="我的转身"/>);
    fireEvent.click(screen.getByRole('button', {name: '自动播放'}));
    act(() => {vi.advanceTimersByTime(160);});
    expect(screen.getByRole('img')).toHaveAttribute('src', frames[2]);
    fireEvent.click(screen.getByRole('button', {name: '暂停转身'}));
    act(() => {vi.advanceTimersByTime(400);});
    expect(screen.getByRole('img')).toHaveAttribute('src', frames[2]);
  });

  it('shows no invented preview when the server has no frame URLs', () => {
    render(<RotationViewer frames={[]} name="未完成转身"/>);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.getByText('这条转身记录还没有可显示的帧图片。')).toBeInTheDocument();
  });
});
