# ponytail: a single stage + vite preview. The COOP/COEP headers are already in vite.config, so no nginx conf is used.
# If the image size becomes a problem, switch to multi-stage + a static server.
FROM node:20-alpine
WORKDIR /app
COPY . .
RUN npm ci && npm run build
EXPOSE 4173
CMD ["npm", "run", "preview", "-w", "three-slicer-viewer", "--", "--host", "0.0.0.0", "--port", "4173"]
