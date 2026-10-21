#!/bin/sh
#
# Builds small static ffmpeg and ffprobe binaries for the TV (Linux aarch64, musl) with only
# what the app uses: the codecs of the files it plays, the AAC/AC3 and H.264 (libx264) encoders
# the streaming server's HLS conversion asks for, the filters its converter always adds (apad for every
# audio conversion, setparams and tpad for picture re-encodes, aselect for HLS v1), HTTP and HTTPS input
# (mbedTLS) and the HLS/MP4/Matroska outputs.
# The official full static build is ~75 MB per binary and does not fit the TV app partition.
#
# Runs inside an arm64 Alpine container (Docker on Apple Silicon runs it natively).
# Usage: ./tools/build-ffmpeg.sh   (writes service/bin/ffmpeg and service/bin/ffprobe)
#
set -eu

FFMPEG_VERSION="${FFMPEG_VERSION:-7.1.1}"
FFMPEG_SHA256="${FFMPEG_SHA256:-733984395e0dbbe5c046abda2dc49a5544e7e0e1e2366bba849222ae9e3a03b1}"
X264_BRANCH="${X264_BRANCH:-stable}"
# Sources are tried in order, so one unreachable server does not stop the build; the checksum makes every mirror safe
FFMPEG_MIRRORS="${FFMPEG_MIRRORS:-https://ffmpeg.org/releases https://distfiles.alpinelinux.org/distfiles/edge https://distfiles.alpinelinux.org/distfiles/v3.22}"
X264_REPOS="${X264_REPOS:-https://github.com/mirror/x264.git https://code.videolan.org/videolan/x264.git}"
# On an IPv6-only network the container needs the host network to reach the internet
DOCKER_NETWORK="${DOCKER_NETWORK:-bridge}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$HERE/service/bin"

docker run --rm --platform linux/arm64 --network "$DOCKER_NETWORK" -v "$HERE/service/bin:/out" alpine:3.20 sh -euxc "
apk add --no-cache build-base pkgconf git xz nasm perl linux-headers bash mbedtls-dev mbedtls-static
cd /tmp
for repo in $X264_REPOS
do
    if git clone --depth 1 -b $X264_BRANCH \$repo x264
    then
        break
    fi
    rm -rf x264
done
cd x264
./configure --prefix=/usr/local --enable-static --disable-cli --disable-opencl --enable-pic
make -j\$(nproc) install
cd /tmp
for mirror in $FFMPEG_MIRRORS
do
    rm -f ffmpeg-$FFMPEG_VERSION.tar.xz
    if wget -q -T 60 \$mirror/ffmpeg-$FFMPEG_VERSION.tar.xz
    then
        if echo '$FFMPEG_SHA256  ffmpeg-$FFMPEG_VERSION.tar.xz' | sha256sum -c -
        then
            break
        fi
    fi
done
echo '$FFMPEG_SHA256  ffmpeg-$FFMPEG_VERSION.tar.xz' | sha256sum -c -
tar xJf ffmpeg-$FFMPEG_VERSION.tar.xz
cd ffmpeg-$FFMPEG_VERSION
PKG_CONFIG_PATH=/usr/local/lib/pkgconfig ./configure \
  --prefix=/usr/local --pkg-config-flags=--static --extra-ldflags=-static --extra-cflags=-I/usr/local/include \
  --enable-static --disable-shared --enable-gpl --enable-libx264 \
  --disable-autodetect --disable-doc --disable-debug --disable-ffplay --disable-everything --enable-version3 --enable-mbedtls \
  --enable-protocol=file,pipe,http,https,tcp,tls \
  --enable-demuxer=matroska,mov,mpegts,avi,flv,hls,wav,aac,ac3,eac3,dts,truehd,mp3,flac,ogg,srt,ass,webvtt,h264,hevc,m4v,mpegps \
  --enable-decoder=h264,hevc,mpeg4,mpeg2video,mpeg1video,vp8,vp9,vc1,wmv3,mjpeg,aac,aac_latm,ac3,eac3,dca,truehd,mlp,flac,opus,mp3,mp2,vorbis,pcm_s16le,pcm_s24le,pcm_s16be,pcm_bluray,pcm_dvd,subrip,ass,ssa,webvtt,mov_text,dvdsub,pgssub \
  --enable-encoder=libx264,aac,ac3,eac3,pcm_s16le,webvtt,subrip,ass \
  --enable-muxer=hls,mpegts,mp4,ipod,matroska,webm,segment,wav,webvtt,srt,ass,null,adts \
  --enable-parser=h264,hevc,mpeg4video,mpegvideo,vp8,vp9,vc1,aac,aac_latm,ac3,dca,mlp,mpegaudio,flac,opus,vorbis \
  --enable-bsf=h264_mp4toannexb,hevc_mp4toannexb,aac_adtstoasc,extract_extradata,dca_core,truehd_core \
  --enable-filter=aresample,aformat,anull,null,scale,format,fps,setpts,asetpts,pan,copy,apad,setparams,tpad,aselect \
  --enable-swresample --enable-swscale
make -j\$(nproc)
strip ffmpeg ffprobe
cp ffmpeg ffprobe /out/
ls -la /out
./ffmpeg -hide_banner -version | head -3
"
