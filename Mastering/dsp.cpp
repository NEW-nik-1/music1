/*
 Studio Mastering WebAssembly DSP core.
 Build with Emscripten:

 emcc dsp.cpp -O3 -msimd128 \
   -s WASM=1 \
   -s EXPORTED_FUNCTIONS='["_true_peak","_rms","_fft_power"]' \
   -s EXPORTED_RUNTIME_METHODS='["cwrap"]' \
   -o dsp.js

 The browser UI uses AudioWorklet for streaming processing. This C++ core
 provides SIMD/WASM metering primitives that can be wired into the worklet
 for very large projects or real-time metering.
*/

#include <cmath>
#include <cstddef>
#include <algorithm>

extern "C" {

float true_peak(const float* x, int n) {
    float p=0.0f;
    for(int i=0;i<n;i++){
        p=std::max(p,std::fabs(x[i]));
        if(i+1<n){
            float a=x[i],b=x[i+1];
            for(int k=1;k<4;k++){
                float v=a+(b-a)*(float(k)/4.0f);
                p=std::max(p,std::fabs(v));
            }
        }
    }
    return p;
}

float rms(const float* x, int n) {
    double s=0.0;
    for(int i=0;i<n;i++) s += double(x[i])*double(x[i]);
    return n ? float(std::sqrt(s/n)) : 0.0f;
}

/* Simple in-place radix-2 power spectrum.
   re/im must contain n samples, n must be a power of two. */
void fft_power(float* re, float* im, int n) {
    for(int i=1,j=0;i<n;i++){
        int bit=n>>1;
        for(;j&bit;bit>>=1) j^=bit;
        j^=bit;
        if(i<j){
            std::swap(re[i],re[j]);
            std::swap(im[i],im[j]);
        }
    }
    for(int len=2;len<=n;len<<=1){
        const float ang=-2.0f*3.14159265358979323846f/len;
        const float c=std::cos(ang),s=std::sin(ang);
        for(int i=0;i<n;i+=len){
            float wr=1,wi=0;
            for(int j=0;j<len/2;j++){
                float ur=re[i+j],ui=im[i+j];
                float vr=re[i+j+len/2]*wr-im[i+j+len/2]*wi;
                float vi=re[i+j+len/2]*wi+im[i+j+len/2]*wr;
                re[i+j]=ur+vr; im[i+j]=ui+vi;
                re[i+j+len/2]=ur-vr; im[i+j+len/2]=ui-vi;
                float nr=wr*c-wi*s; wi=wr*s+wi*c; wr=nr;
            }
        }
    }
}

}
