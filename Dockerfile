# CI image (base build and runtime environment)
FROM public.ecr.aws/lts/ubuntu:22.04_stable AS ci
ARG DEBIAN_FRONTEND=noninteractive

# Update and install essential tools
RUN apt update && apt upgrade -y && \
    apt install -y \
    build-essential cmake ninja-build git curl wget ca-certificates zip \
    software-properties-common dumb-init \
    python3-pip unzip sudo && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Create dev sudo user
RUN useradd --create-home dev && \
    usermod --append --groups sudo dev && \
    echo '%sudo ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# Devcontainer image (adds developer conveniences)
FROM ci AS dev

USER root
ARG DEBIAN_FRONTEND=noninteractive

# Install dev-specific tools
RUN apt update && \
    apt install -y \
    man make zsh vim procps gnupg gnupg2 && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Unminimize the system
RUN bash -c "yes | unminimize"

# Setup oh-my-zsh for dev user
USER dev
ARG DOCKER_OHMYZSH_SCRIPT_NAME=zsh-in-docker.sh
ARG DOCKER_OHMYZSH_SCRIPT_URL=https://github.com/deluan/zsh-in-docker/releases/download/v1.1.3/${DOCKER_OHMYZSH_SCRIPT_NAME}
ARG DOCKER_OHMYZSH_SCRIPT_HASH="ffa8175332ef01b500ace59d03ce7e2f3a7453651e9a37060974bb6536f0706b  ${DOCKER_OHMYZSH_SCRIPT_NAME}"
RUN cd /tmp && \
    wget ${DOCKER_OHMYZSH_SCRIPT_URL} && \
    echo ${DOCKER_OHMYZSH_SCRIPT_HASH} | sha256sum -c && \
    chmod +x ./${DOCKER_OHMYZSH_SCRIPT_NAME} && \
    ./${DOCKER_OHMYZSH_SCRIPT_NAME} -t robbyrussell -p git -p ssh-agent && \
    sudo rm ./${DOCKER_OHMYZSH_SCRIPT_NAME}

USER dev
