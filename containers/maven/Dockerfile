FROM node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90 AS node
WORKDIR /opt/runner
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM maven:3.9.9-eclipse-temurin-17@sha256:f58d59b6273e785ac0a4477f6e9b5ba1d7731c75b906c0f7b34076f1851318cc
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /opt/runner /opt/runner
COPY src /opt/runner/src
COPY java-adapter /opt/runner/java-adapter
COPY containers/maven/worker.ts /opt/runner/containers/maven/worker.ts
COPY containers/maven/storage.ts /opt/runner/containers/maven/storage.ts
RUN mkdir -p /workspace/project /input /maven-repository && chown -R 1000:1000 /workspace /input /maven-repository
ENV HOME=/tmp MAVEN_CONFIG=/tmp/.m2
WORKDIR /workspace/project
USER 1000:1000
ENTRYPOINT ["node", "/opt/runner/containers/maven/worker.ts"]
