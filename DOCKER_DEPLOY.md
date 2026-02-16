# DifyModel Docker Deployment

## 1. GitHub Actions Auto Build and Push

Workflow file: `.github/workflows/docker-build-push.yml`

Trigger conditions:
- push to `main` or `master`
- push tag matching `v*`
- manual trigger from GitHub Actions

Required GitHub Secrets:
- `DOCKER_USERNAME`: Docker Hub username
- `DOCKER_PASSWORD`: Docker Hub Access Token

Produced image tags:
- `${DOCKER_USERNAME}/dify-model:latest`
- `${DOCKER_USERNAME}/dify-model:<tag-or-commit>`

## 2. Server Deployment with Docker Compose

1. Prepare environment file:

```bash
cp configs/environments/.env.example .env
```

2. Set image in `.env` (or shell env):

```bash
echo "DOCKER_IMAGE=<your-dockerhub-username>/dify-model:latest" >> .env
```

3. Start service:

```bash
docker compose up -d
```

4. Verify:

```bash
curl http://127.0.0.1:8080/health
docker compose ps
```

## 3. Update to New Image

```bash
docker compose pull
docker compose up -d
```
