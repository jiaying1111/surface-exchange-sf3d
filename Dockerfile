FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build
ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787
CMD ["npm", "start"]
