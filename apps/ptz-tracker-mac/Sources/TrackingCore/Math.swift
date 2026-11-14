#if os(Linux)
import Glibc
#else
import Darwin
#endif

enum PtMath {
    static func exp(_ x: Double) -> Double {
        #if os(Linux)
        Glibc.exp(x)
        #else
        Darwin.exp(x)
        #endif
    }

    static func tanh(_ x: Double) -> Double {
        #if os(Linux)
        Glibc.tanh(x)
        #else
        Darwin.tanh(x)
        #endif
    }
}
