//
//  AcademyLSDefault.m
//  Minion — LaunchServices default-handler helper
//  (Distro files/24 section 5b, tranche MD-T3).
//
//  The whole surface is three verbs and nothing else:
//
//    AcademyLSDefault get
//        Prints the current default handler bundle id for
//        net.daringfireball.markdown on stdout; exit 3 when
//        LaunchServices reports no handler.
//    AcademyLSDefault set
//        Sets the default handler for that one content type to
//        MacDown.
//    AcademyLSDefault restore <bundle-id>
//        Sets the default handler back to the recorded predecessor.
//
//  The content type and the MacDown bundle id are compiled-in
//  constants — no caller input can retarget them. The only
//  caller-supplied value is the restore target, which the shell
//  passes from its own recorded state (it was read back from
//  LaunchServices by `get` before the set; it never comes from
//  page content), and it is validated here against a strict
//  bundle-id shape before use. public.plain-text is deliberately
//  never touched (files/24 section 5b exclusion). No file or
//  network I/O, no other verb, no other argument shape.
//
//  macOS 10.13 floor. ARC-free plain main; built by CI with
//  clang -arch x86_64 -mmacosx-version-min=10.13
//  -framework CoreServices -framework Foundation.
//

#import <CoreServices/CoreServices.h>
#import <Foundation/Foundation.h>

static NSString *const kMarkdownUTI = @"net.daringfireball.markdown";
static NSString *const kMacDownBundleID =
    @"com.detroitautomationacademy.macdown";

static BOOL IsBundleIDShaped(NSString *candidate) {
    if ([candidate length] == 0 || [candidate length] > 128) {
        return NO;
    }
    NSCharacterSet *allowed = [NSCharacterSet
        characterSetWithCharactersInString:
            @"ABCDEFGHIJKLMNOPQRSTUVWXYZ"
             "abcdefghijklmnopqrstuvwxyz0123456789.-"];
    for (NSUInteger i = 0; i < [candidate length]; i++) {
        if (![allowed characterIsMember:[candidate characterAtIndex:i]]) {
            return NO;
        }
    }
    return [candidate rangeOfString:@"."].location != NSNotFound;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc < 2) {
            return 64; // EX_USAGE
        }
        NSString *verb = [NSString stringWithUTF8String:argv[1]];
        if ([verb isEqualToString:@"get"] && argc == 2) {
            CFStringRef current = LSCopyDefaultRoleHandlerForContentType(
                (__bridge CFStringRef)kMarkdownUTI, kLSRolesAll);
            if (current == NULL) {
                return 3;
            }
            printf("%s\n", [(__bridge NSString *)current UTF8String]);
            CFRelease(current);
            return 0;
        }
        if ([verb isEqualToString:@"set"] && argc == 2) {
            OSStatus status = LSSetDefaultRoleHandlerForContentType(
                (__bridge CFStringRef)kMarkdownUTI, kLSRolesAll,
                (__bridge CFStringRef)kMacDownBundleID);
            return status == noErr ? 0 : 2;
        }
        if ([verb isEqualToString:@"restore"] && argc == 3) {
            NSString *target = [NSString stringWithUTF8String:argv[2]];
            if (!IsBundleIDShaped(target)) {
                return 64;
            }
            OSStatus status = LSSetDefaultRoleHandlerForContentType(
                (__bridge CFStringRef)kMarkdownUTI, kLSRolesAll,
                (__bridge CFStringRef)target);
            return status == noErr ? 0 : 2;
        }
        return 64;
    }
}
