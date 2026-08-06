# ponytail: 단일 스테이지 + vite preview. COOP/COEP 헤더가 vite.config 에 이미 있어 nginx conf 를 안 쓴다.
# 이미지 크기가 문제되면 multi-stage + 정적 서버로 교체.
FROM node:20-alpine
WORKDIR /app
COPY . .
RUN npm ci && npm run build
EXPOSE 4173
CMD ["npm", "run", "preview", "-w", "three-slicer-viewer", "--", "--host", "0.0.0.0", "--port", "4173"]
