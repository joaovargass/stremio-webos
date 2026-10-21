#!/bin/sh
#
# Builds small static ffmpeg and ffprobe binaries for the TV (Linux aarch64, musl) with only
# what the app uses: the codecs of the files it plays, the AAC/AC3 and H.264 (libx264) encoders
# the streaming server's HLS conversion asks for, HTTP input and the HLS/MP4/Matroska outputs.
# The official full static build is ~75 MB per binary and does not fit the TV app partition.
#
# Runs inside an arm64 Alpine container (Docker on Apple Silicon runs it natively).
# Usage: ./tools/build-ffmpeg.sh   (writes service/bin/ffmpeg and service/bin/ffprobe)
#
set -eu

FFMPEG_VERSION="${FFMPEG_VERSION:-7.1.1}"
X264_BRANCH="${X264_BRANCH:-stable}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$HERE/service/bin"

docker run --rm --platform linux/arm64 -v "$HERE/service/bin:/out" alpine:3.20 sh -euxc "
apk add --no-cache build-base pkgconf git xz nasm perl linux-headers bash
cd /tmp
git clone --depth 1 -b $X264_BRANCH https://github.com/mirror/x264.git
cd x264
./configure --prefix=/usr/local --enable-static --disable-cli --disable-opencl --enable-pic
make -j\$(nproc) install
cd /tmp
wget -q https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz
sha256sum ffmpeg-$FFMPEG_VERSION.tar.xz
tar xJf ffmpeg-$FFMPEG_VERSION.tar.xz
cd ffmpeg-$FFMPEG_VERSION
PKG_CONFIG_PATH=/usr/local/lib/pkgconfig ./configure \
  --prefix=/usr/local --pkg-config-flags=--static --extra-ldflags=-static --extra-cflags=-I/usr/local/include \
  --enable-static --disable-shared --enable-gpl --enable-libx264 \
  --disable-autodetect --disable-doc --disable-debug --disable-ffplay --disable-everything \
  --enable-protocol=file,pipe,http,tcp \
  --enable-demuxer=matroska,mov,mpegts,avi,flv,hls,wav,aac,ac3,eac3,dts,truehd,mp3,flac,ogg,srt,ass,webvtt,h264,hevc,m4v,mpegps \
  --enable-decoder=h264,hevc,mpeg4,mpeg2video,mpeg1video,vp8,vp9,vc1,wmv3,mjpeg,aac,aac_latm,ac3,eac3,dca,truehd,mlp,flac,opus,mp3,mp2,vorbis,pcm_s16le,pcm_s24le,pcm_s16be,pcm_bluray,pcm_dvd,subrip,ass,ssa,webvtt,mov_text,dvdsub,pgssub \
  --enable-encoder=libx264,aac,ac3,eac3,pcm_s16le,webvtt,subrip,ass \
  --enable-muxer=hls,mpegts,mp4,ipod,matroska,webm,segment,wav,webvtt,srt,ass,null,adts \
  --enable-parser=h264,hevc,mpeg4video,mpegvideo,vp8,vp9,vc1,aac,aac_latm,ac3,dca,mlp,mpegaudio,flac,opus,vorbis \
  --enable-bsf=h264_mp4toannexb,hevc_mp4toannexb,aac_adtstoasc,extract_extradata,dca_core,truehd_core \
  --enable-filter=aresample,aformat,anull,null,scale,format,fps,setpts,asetpts,pan,copy \
  --enable-swresample --enable-swscale
make -j\$(nproc)
strip ffmpeg ffprobe
cp ffmpeg ffprobe /out/
ls -la /out
./ffmpeg -hide_banner -version | head -3
"
