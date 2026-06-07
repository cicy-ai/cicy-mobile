import { Text } from './Text';

// 上下文用量指示 — native 回退版:没有 SVG 依赖,显示带档位色的百分比文本。
// web 版(CtxRing.web.tsx)渲染和 cicy-code TeamPanel 一致的圆环。
// 配色档位与 cicy-code 相同:>80 红,>50 黄,其余中性灰。
export function ctxRingColor(pct: number): string {
  return pct > 80 ? '#b91c1c' : pct > 50 ? '#ca8a04' : '#71717a';
}

export function CtxRing({ pct }: { pct: number }) {
  return (
    <Text variant="caption" style={{ color: ctxRingColor(pct), fontSize: 11 }}>
      {pct}%
    </Text>
  );
}
