#import <Cocoa/Cocoa.h>
#import <Security/Security.h>
#import <WebKit/WebKit.h>
#import <signal.h>

static NSString *const MarginReadyPrefix = @"MARGIN_READY ";
static NSString *const MarginLibraryDefaultsKey = @"MarginLibraryPath";
static const unsigned long long MarginLogLimit = 2 * 1024 * 1024;

@interface MarginAppDelegate : NSObject <NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate>

@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) WKWebView *webView;
@property(nonatomic, strong) NSView *statusView;
@property(nonatomic, strong) NSTextField *statusTitle;
@property(nonatomic, strong) NSTextField *statusDetail;
@property(nonatomic, strong) NSProgressIndicator *progressIndicator;
@property(nonatomic, strong) NSButton *retryButton;
@property(nonatomic, strong) NSButton *showLogButton;

@property(nonatomic, strong) NSTask *serverTask;
@property(nonatomic, strong) NSPipe *stdoutPipe;
@property(nonatomic, strong) NSPipe *stderrPipe;
@property(nonatomic, strong) NSMutableData *stdoutBuffer;
@property(nonatomic, strong) NSMutableData *stderrBuffer;
@property(nonatomic, strong) NSURL *readyURL;
@property(nonatomic, strong) NSURL *contentOrigin;
@property(nonatomic, strong) NSURL *readyFileURL;
@property(nonatomic, strong) NSURL *workspaceURL;
@property(nonatomic, copy) NSString *sessionToken;

@property(nonatomic, strong) NSURL *logURL;
@property(nonatomic, strong) NSFileHandle *logHandle;
@property(nonatomic) dispatch_queue_t logQueue;
@property(nonatomic) unsigned long long logBytes;
@property(nonatomic) NSUInteger generation;
@property(nonatomic) BOOL restartAfterStop;
@property(nonatomic) BOOL suppressTerminationError;
@property(nonatomic) BOOL quitting;
@property(nonatomic) BOOL terminationReplyPending;

@end

@implementation MarginAppDelegate

- (NSString *)appDisplayName {
  NSString *name = NSBundle.mainBundle.infoDictionary[@"CFBundleDisplayName"];
  return name.length ? name : @"Margin";
}

- (BOOL)isDevelopmentBuild {
  NSString *path = NSBundle.mainBundle.infoDictionary[@"MarginDevelopmentRoot"];
  return path.length > 0;
}

- (NSURL *)developmentRootURL {
  NSString *path = NSBundle.mainBundle.infoDictionary[@"MarginDevelopmentRoot"];
  if (!path.length || !path.isAbsolutePath) return nil;
  BOOL isDirectory = NO;
  if (![NSFileManager.defaultManager fileExistsAtPath:path isDirectory:&isDirectory] || !isDirectory) return nil;
  return [NSURL fileURLWithPath:path isDirectory:YES];
}

- (NSString *)localStateName {
  return [self isDevelopmentBuild] ? @"Margin Dev" : @"Margin";
}

- (instancetype)init {
  self = [super init];
  if (self) {
    _logQueue = dispatch_queue_create("io.github.zhi0467.margin.server-log", DISPATCH_QUEUE_SERIAL);
    _stdoutBuffer = [NSMutableData data];
    _stderrBuffer = [NSMutableData data];
  }
  return self;
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  (void)notification;
  [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
  [self installMainMenu];
  [self buildWindow];
  [self.window makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
  [self startBackend];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
  (void)sender;
  return YES;
}

- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender hasVisibleWindows:(BOOL)hasVisibleWindows {
  (void)sender;
  if (!hasVisibleWindows) [self.window makeKeyAndOrderFront:nil];
  return YES;
}

- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
  (void)sender;
  self.quitting = YES;

  NSTask *task = self.serverTask;
  if (!task || !task.running) return NSTerminateNow;

  self.terminationReplyPending = YES;
  [task terminate];

  __weak typeof(self) weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    typeof(self) self = weakSelf;
    if (!self || !self.terminationReplyPending) return;
    NSTask *runningTask = self.serverTask;
    if (runningTask.running) kill(runningTask.processIdentifier, SIGKILL);
    self.terminationReplyPending = NO;
    [NSApp replyToApplicationShouldTerminate:YES];
  });
  return NSTerminateLater;
}

- (void)applicationWillTerminate:(NSNotification *)notification {
  (void)notification;
  self.stdoutPipe.fileHandleForReading.readabilityHandler = nil;
  self.stderrPipe.fileHandleForReading.readabilityHandler = nil;
  dispatch_sync(self.logQueue, ^{
    [self.logHandle synchronizeFile];
    [self.logHandle closeFile];
    self.logHandle = nil;
  });
  if (self.readyFileURL) [NSFileManager.defaultManager removeItemAtURL:self.readyFileURL error:nil];
}

- (void)installMainMenu {
  NSMenu *menuBar = [[NSMenu alloc] initWithTitle:@""];
  NSMenuItem *appMenuItem = [[NSMenuItem alloc] initWithTitle:@"" action:nil keyEquivalent:@""];
  [menuBar addItem:appMenuItem];

  NSString *appName = [self appDisplayName];
  NSMenu *appMenu = [[NSMenu alloc] initWithTitle:appName];
  [appMenu addItemWithTitle:[NSString stringWithFormat:@"About %@", appName]
                     action:@selector(orderFrontStandardAboutPanel:)
              keyEquivalent:@""];
  [appMenu addItem:[NSMenuItem separatorItem]];
  [appMenu addItemWithTitle:@"Change Library…" action:@selector(changeLibrary:) keyEquivalent:@""];
  [appMenu addItemWithTitle:@"Show server log" action:@selector(showLog:) keyEquivalent:@""];
  [appMenu addItem:[NSMenuItem separatorItem]];
  [appMenu addItemWithTitle:[NSString stringWithFormat:@"Quit %@", appName]
                     action:@selector(terminate:)
              keyEquivalent:@"q"];
  appMenuItem.submenu = appMenu;

  NSMenuItem *editMenuItem = [[NSMenuItem alloc] initWithTitle:@"" action:nil keyEquivalent:@""];
  [menuBar addItem:editMenuItem];
  NSMenu *editMenu = [[NSMenu alloc] initWithTitle:@"Edit"];

  NSMenuItem *undoItem = [editMenu addItemWithTitle:@"Undo" action:@selector(undo:) keyEquivalent:@"z"];
  undoItem.target = nil;
  NSMenuItem *redoItem = [editMenu addItemWithTitle:@"Redo" action:@selector(redo:) keyEquivalent:@"z"];
  redoItem.target = nil;
  redoItem.keyEquivalentModifierMask = NSEventModifierFlagCommand | NSEventModifierFlagShift;
  [editMenu addItem:[NSMenuItem separatorItem]];

  NSMenuItem *cutItem = [editMenu addItemWithTitle:@"Cut" action:@selector(cut:) keyEquivalent:@"x"];
  cutItem.target = nil;
  NSMenuItem *copyItem = [editMenu addItemWithTitle:@"Copy" action:@selector(copy:) keyEquivalent:@"c"];
  copyItem.target = nil;
  NSMenuItem *pasteItem = [editMenu addItemWithTitle:@"Paste" action:@selector(paste:) keyEquivalent:@"v"];
  pasteItem.target = nil;
  [editMenu addItem:[NSMenuItem separatorItem]];
  NSMenuItem *selectAllItem = [editMenu addItemWithTitle:@"Select All" action:@selector(selectAll:) keyEquivalent:@"a"];
  selectAllItem.target = nil;
  editMenuItem.submenu = editMenu;

  NSMenuItem *viewMenuItem = [[NSMenuItem alloc] initWithTitle:@"" action:nil keyEquivalent:@""];
  [menuBar addItem:viewMenuItem];
  NSMenu *viewMenu = [[NSMenu alloc] initWithTitle:@"View"];
  NSMenuItem *togglePanelsItem = [[NSMenuItem alloc] initWithTitle:@"Toggle Course Panel"
                                                            action:@selector(toggleSidePanels:)
                                                     keyEquivalent:@"b"];
  togglePanelsItem.target = self;
  togglePanelsItem.keyEquivalentModifierMask = NSEventModifierFlagCommand;
  [viewMenu addItem:togglePanelsItem];
  viewMenuItem.submenu = viewMenu;

  NSMenuItem *windowMenuItem = [[NSMenuItem alloc] initWithTitle:@"" action:nil keyEquivalent:@""];
  [menuBar addItem:windowMenuItem];
  NSMenu *windowMenu = [[NSMenu alloc] initWithTitle:@"Window"];
  [windowMenu addItemWithTitle:@"Minimize" action:@selector(performMiniaturize:) keyEquivalent:@"m"];
  [windowMenu addItemWithTitle:@"Zoom" action:@selector(performZoom:) keyEquivalent:@""];
  windowMenuItem.submenu = windowMenu;
  NSApp.windowsMenu = windowMenu;
  NSApp.mainMenu = menuBar;
}

- (void)buildWindow {
  NSRect frame = NSMakeRect(0, 0, 1280, 820);
  NSWindowStyleMask style = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                            NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable;
  self.window = [[NSWindow alloc] initWithContentRect:frame styleMask:style backing:NSBackingStoreBuffered defer:NO];
  self.window.title = [self appDisplayName];
  self.window.minSize = NSMakeSize(900, 600);
  self.window.tabbingMode = NSWindowTabbingModeDisallowed;
  [self.window center];

  NSView *content = self.window.contentView;
  content.wantsLayer = YES;
  content.layer.backgroundColor = [NSColor colorWithSRGBRed:248.0 / 255.0
                                                     green:244.0 / 255.0
                                                      blue:236.0 / 255.0
                                                     alpha:1.0].CGColor;

  WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
  configuration.websiteDataStore = [WKWebsiteDataStore defaultDataStore];
  self.webView = [[WKWebView alloc] initWithFrame:NSZeroRect configuration:configuration];
  self.webView.navigationDelegate = self;
  self.webView.UIDelegate = self;
  self.webView.translatesAutoresizingMaskIntoConstraints = NO;
  self.webView.hidden = YES;
  [content addSubview:self.webView];

  self.statusView = [[NSView alloc] initWithFrame:NSZeroRect];
  self.statusView.translatesAutoresizingMaskIntoConstraints = NO;
  [content addSubview:self.statusView];

  NSImageView *iconView = [[NSImageView alloc] initWithFrame:NSZeroRect];
  iconView.image = NSApp.applicationIconImage;
  iconView.imageScaling = NSImageScaleProportionallyUpOrDown;
  iconView.translatesAutoresizingMaskIntoConstraints = NO;

  self.statusTitle = [NSTextField labelWithString:@"Opening your library"];
  self.statusTitle.font = [NSFont systemFontOfSize:24 weight:NSFontWeightSemibold];
  self.statusTitle.textColor = [NSColor colorWithSRGBRed:36.0 / 255.0
                                                  green:33.0 / 255.0
                                                   blue:29.0 / 255.0
                                                  alpha:1.0];
  self.statusTitle.alignment = NSTextAlignmentCenter;

  self.statusDetail = [NSTextField wrappingLabelWithString:@"Starting the local teaching service…"];
  self.statusDetail.font = [NSFont systemFontOfSize:14 weight:NSFontWeightRegular];
  self.statusDetail.textColor = [NSColor secondaryLabelColor];
  self.statusDetail.alignment = NSTextAlignmentCenter;
  self.statusDetail.maximumNumberOfLines = 4;
  [self.statusDetail.widthAnchor constraintLessThanOrEqualToConstant:520].active = YES;

  self.progressIndicator = [[NSProgressIndicator alloc] initWithFrame:NSZeroRect];
  self.progressIndicator.style = NSProgressIndicatorStyleSpinning;
  self.progressIndicator.controlSize = NSControlSizeSmall;
  self.progressIndicator.indeterminate = YES;

  self.retryButton = [NSButton buttonWithTitle:[NSString stringWithFormat:@"Restart %@", [self appDisplayName]]
                                        target:self
                                        action:@selector(retryBackend:)];
  self.retryButton.bezelStyle = NSBezelStyleRounded;
  self.retryButton.keyEquivalent = @"\r";
  self.retryButton.hidden = YES;

  self.showLogButton = [NSButton buttonWithTitle:@"Show server log" target:self action:@selector(showLog:)];
  self.showLogButton.bezelStyle = NSBezelStyleRounded;
  self.showLogButton.hidden = YES;

  NSStackView *buttonRow = [NSStackView stackViewWithViews:@[self.retryButton, self.showLogButton]];
  buttonRow.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  buttonRow.alignment = NSLayoutAttributeCenterY;
  buttonRow.spacing = 8;

  NSStackView *stack = [NSStackView stackViewWithViews:@[
    iconView,
    self.statusTitle,
    self.statusDetail,
    self.progressIndicator,
    buttonRow,
  ]];
  stack.orientation = NSUserInterfaceLayoutOrientationVertical;
  stack.alignment = NSLayoutAttributeCenterX;
  stack.spacing = 12;
  stack.translatesAutoresizingMaskIntoConstraints = NO;
  [stack setCustomSpacing:20 afterView:iconView];
  [stack setCustomSpacing:6 afterView:self.statusTitle];
  [stack setCustomSpacing:20 afterView:self.statusDetail];
  [self.statusView addSubview:stack];

  [NSLayoutConstraint activateConstraints:@[
    [self.webView.leadingAnchor constraintEqualToAnchor:content.leadingAnchor],
    [self.webView.trailingAnchor constraintEqualToAnchor:content.trailingAnchor],
    [self.webView.topAnchor constraintEqualToAnchor:content.topAnchor],
    [self.webView.bottomAnchor constraintEqualToAnchor:content.bottomAnchor],
    [self.statusView.leadingAnchor constraintEqualToAnchor:content.leadingAnchor],
    [self.statusView.trailingAnchor constraintEqualToAnchor:content.trailingAnchor],
    [self.statusView.topAnchor constraintEqualToAnchor:content.topAnchor],
    [self.statusView.bottomAnchor constraintEqualToAnchor:content.bottomAnchor],
    [stack.centerXAnchor constraintEqualToAnchor:self.statusView.centerXAnchor],
    [stack.centerYAnchor constraintEqualToAnchor:self.statusView.centerYAnchor constant:-12],
    [iconView.widthAnchor constraintEqualToConstant:76],
    [iconView.heightAnchor constraintEqualToConstant:76],
  ]];
}

- (IBAction)toggleSidePanels:(id)sender {
  (void)sender;
  NSString *script = @"window.dispatchEvent(new CustomEvent('margin:toggle-course-panel'))";
  [self.webView evaluateJavaScript:script completionHandler:nil];
}

- (void)showStatusWithTitle:(NSString *)title
                     detail:(NSString *)detail
                    loading:(BOOL)loading
                      retry:(BOOL)retry {
  dispatch_async(dispatch_get_main_queue(), ^{
    self.statusTitle.stringValue = title;
    self.statusDetail.stringValue = detail;
    self.statusView.hidden = NO;
    self.webView.hidden = YES;
    self.progressIndicator.hidden = !loading;
    self.retryButton.hidden = !retry;
    self.showLogButton.hidden = !retry || !self.logURL;
    if (loading) {
      [self.progressIndicator startAnimation:nil];
    } else {
      [self.progressIndicator stopAnimation:nil];
    }
  });
}

- (NSURL *)savedLibraryURL {
  NSString *path = [NSUserDefaults.standardUserDefaults stringForKey:MarginLibraryDefaultsKey];
  if (!path.length) return nil;
  BOOL isDirectory = NO;
  if (![NSFileManager.defaultManager fileExistsAtPath:path isDirectory:&isDirectory] || !isDirectory) return nil;
  return [NSURL fileURLWithPath:path isDirectory:YES];
}

- (void)saveLibraryURL:(NSURL *)url {
  [NSUserDefaults.standardUserDefaults setObject:url.path forKey:MarginLibraryDefaultsKey];
}

- (NSURL *)chooseExistingLibrary {
  NSOpenPanel *panel = [NSOpenPanel openPanel];
  panel.title = @"Choose a Margin library";
  panel.message = @"Margin stores courses and learning records in this folder.";
  panel.prompt = @"Use Library";
  panel.canChooseFiles = NO;
  panel.canChooseDirectories = YES;
  panel.canCreateDirectories = YES;
  panel.allowsMultipleSelection = NO;
  return [panel runModal] == NSModalResponseOK ? panel.URL : nil;
}

- (NSURL *)createLibrary {
  NSSavePanel *panel = [NSSavePanel savePanel];
  panel.title = @"Create a Margin library";
  panel.message = @"Choose a name and location for your new learning library.";
  panel.prompt = @"Create Library";
  panel.nameFieldStringValue = @"Margin Library";
  panel.canCreateDirectories = YES;
  if ([panel runModal] != NSModalResponseOK) return nil;

  NSURL *url = panel.URL;
  NSError *error = nil;
  if (![NSFileManager.defaultManager createDirectoryAtURL:url
                               withIntermediateDirectories:NO
                                                attributes:nil
                                                     error:&error]) {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.alertStyle = NSAlertStyleWarning;
    alert.messageText = @"Margin could not create that library";
    alert.informativeText = error.localizedDescription ?: @"Choose a different location and try again.";
    [alert runModal];
    return nil;
  }
  return url;
}

- (NSURL *)promptForLibrary {
  NSAlert *alert = [[NSAlert alloc] init];
  alert.messageText = @"Choose your learning library";
  alert.informativeText = @"Margin keeps your courses, notes, and learning records in a folder you choose.";
  [alert addButtonWithTitle:@"Choose Existing…"];
  [alert addButtonWithTitle:@"Create New…"];
  [alert addButtonWithTitle:@"Quit"];
  switch ([alert runModal]) {
    case NSAlertFirstButtonReturn:
      return [self chooseExistingLibrary];
    case NSAlertSecondButtonReturn:
      return [self createLibrary];
    default:
      self.quitting = YES;
      [NSApp terminate:nil];
      return nil;
  }
}

- (NSURL *)nodeExecutableURL {
  if ([self isDevelopmentBuild]) {
    NSString *recordedPath = NSBundle.mainBundle.infoDictionary[@"MarginDevelopmentNodeExecutable"];
    if (recordedPath.length && recordedPath.isAbsolutePath) {
      BOOL isDirectory = NO;
      if ([NSFileManager.defaultManager fileExistsAtPath:recordedPath isDirectory:&isDirectory] &&
          !isDirectory && [NSFileManager.defaultManager isExecutableFileAtPath:recordedPath]) {
        return [NSURL fileURLWithPath:recordedPath isDirectory:NO];
      }
    }
    for (NSString *directory in [[self safePathEnvironment] componentsSeparatedByString:@":"]) {
      NSURL *candidate = [[NSURL fileURLWithPath:directory isDirectory:YES]
          URLByAppendingPathComponent:@"node" isDirectory:NO];
      BOOL isDirectory = NO;
      if ([NSFileManager.defaultManager fileExistsAtPath:candidate.path isDirectory:&isDirectory] &&
          !isDirectory && [NSFileManager.defaultManager isExecutableFileAtPath:candidate.path]) {
        return candidate;
      }
    }
    return nil;
  }
  NSURL *url = [[NSBundle.mainBundle resourceURL] URLByAppendingPathComponent:@"node/bin/node"];
  return [NSFileManager.defaultManager isExecutableFileAtPath:url.path] ? url : nil;
}

- (NSURL *)teachSkillURL {
  NSURL *developmentRoot = [self developmentRootURL];
  NSURL *url = [self isDevelopmentBuild]
      ? [developmentRoot URLByAppendingPathComponent:@".agents/skills/teach/SKILL.md"]
      : [[NSBundle.mainBundle resourceURL] URLByAppendingPathComponent:@"teach/SKILL.md"];
  return [NSFileManager.defaultManager isReadableFileAtPath:url.path] ? url : nil;
}

- (NSURL *)stateRootURL {
  NSFileManager *manager = NSFileManager.defaultManager;
  NSURL *root = [[manager URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask] firstObject];
  NSURL *state = [root URLByAppendingPathComponent:[self localStateName] isDirectory:YES];
  NSError *error = nil;
  if (![manager createDirectoryAtURL:state withIntermediateDirectories:YES attributes:nil error:&error]) return nil;
  return state;
}

- (void)exportProviderIconWithBundleIdentifiers:(NSArray<NSString *> *)bundleIdentifiers
                                       filename:(NSString *)filename
                                      stateRoot:(NSURL *)stateRoot {
  NSURL *applicationURL = nil;
  for (NSString *bundleIdentifier in bundleIdentifiers) {
    applicationURL = [NSWorkspace.sharedWorkspace URLForApplicationWithBundleIdentifier:bundleIdentifier];
    if (applicationURL) break;
  }
  if (!applicationURL) return;

  NSImage *icon = [NSWorkspace.sharedWorkspace iconForFile:applicationURL.path];
  if (!icon) return;
  NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc]
      initWithBitmapDataPlanes:NULL
                    pixelsWide:128
                    pixelsHigh:128
                 bitsPerSample:8
               samplesPerPixel:4
                      hasAlpha:YES
                      isPlanar:NO
                colorSpaceName:NSCalibratedRGBColorSpace
                   bytesPerRow:0
                  bitsPerPixel:0];
  if (!bitmap) return;

  NSGraphicsContext *context = [NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap];
  [NSGraphicsContext saveGraphicsState];
  NSGraphicsContext.currentContext = context;
  [NSColor.clearColor set];
  NSRectFill(NSMakeRect(0, 0, 128, 128));
  [icon drawInRect:NSMakeRect(0, 0, 128, 128)
          fromRect:NSZeroRect
         operation:NSCompositingOperationSourceOver
          fraction:1.0
    respectFlipped:YES
             hints:nil];
  [context flushGraphics];
  [NSGraphicsContext restoreGraphicsState];

  NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
  if (!png.length) return;
  NSURL *directory = [stateRoot URLByAppendingPathComponent:@"provider-icons" isDirectory:YES];
  [NSFileManager.defaultManager createDirectoryAtURL:directory
                          withIntermediateDirectories:YES
                                           attributes:@{NSFilePosixPermissions: @0700}
                                                error:nil];
  NSURL *destination = [directory URLByAppendingPathComponent:filename isDirectory:NO];
  [png writeToURL:destination options:NSDataWritingAtomic error:nil];
  [NSFileManager.defaultManager setAttributes:@{NSFilePosixPermissions: @0600}
                                  ofItemAtPath:destination.path
                                         error:nil];
}

- (void)exportProviderIconsToStateRoot:(NSURL *)stateRoot {
  [self exportProviderIconWithBundleIdentifiers:@[@"com.anthropic.claudefordesktop"]
                                       filename:@"claude.png"
                                      stateRoot:stateRoot];
  [self exportProviderIconWithBundleIdentifiers:@[@"com.openai.codex", @"com.openai.chat"]
                                       filename:@"codex.png"
                                      stateRoot:stateRoot];
}

- (NSString *)newSessionToken {
  uint8_t bytes[32];
  if (SecRandomCopyBytes(kSecRandomDefault, sizeof(bytes), bytes) != errSecSuccess) return nil;
  NSMutableString *token = [NSMutableString stringWithCapacity:sizeof(bytes) * 2];
  for (NSUInteger index = 0; index < sizeof(bytes); index += 1) [token appendFormat:@"%02x", bytes[index]];
  return token;
}

- (NSString *)safePathEnvironment {
  NSString *home = NSHomeDirectory();
  NSMutableOrderedSet<NSString *> *paths = [NSMutableOrderedSet orderedSetWithArray:@[
    [home stringByAppendingPathComponent:@".local/bin"],
    [home stringByAppendingPathComponent:@".npm-global/bin"],
    [home stringByAppendingPathComponent:@".volta/bin"],
    @"/opt/homebrew/bin",
    @"/opt/homebrew/sbin",
    @"/usr/local/bin",
    @"/usr/bin",
    @"/bin",
    @"/usr/sbin",
    @"/sbin",
  ]];
  NSString *inherited = NSProcessInfo.processInfo.environment[@"PATH"];
  for (NSString *component in [inherited componentsSeparatedByString:@":"]) {
    if (component.length) [paths addObject:component];
  }
  return [paths.array componentsJoinedByString:@":"];
}

- (void)prepareLog {
  NSFileManager *manager = NSFileManager.defaultManager;
  NSURL *directory = [[[manager URLsForDirectory:NSLibraryDirectory inDomains:NSUserDomainMask] firstObject]
      URLByAppendingPathComponent:[@"Logs" stringByAppendingPathComponent:[self localStateName]] isDirectory:YES];
  [manager createDirectoryAtURL:directory withIntermediateDirectories:YES attributes:nil error:nil];

  NSURL *logURL = [directory URLByAppendingPathComponent:@"server.log"];
  NSURL *previousURL = [directory URLByAppendingPathComponent:@"server.previous.log"];
  for (NSURL *candidate in @[logURL, previousURL]) {
    NSNumber *size = nil;
    [candidate getResourceValue:&size forKey:NSURLFileSizeKey error:nil];
    if (size.unsignedLongLongValue > MarginLogLimit) [manager removeItemAtURL:candidate error:nil];
  }
  if (![manager fileExistsAtPath:logURL.path]) [manager createFileAtPath:logURL.path contents:nil attributes:nil];

  self.logURL = logURL;
  self.logHandle = [NSFileHandle fileHandleForWritingAtPath:logURL.path];
  [self.logHandle seekToEndOfFile];
  NSNumber *size = nil;
  [logURL getResourceValue:&size forKey:NSURLFileSizeKey error:nil];
  self.logBytes = size.unsignedLongLongValue;
  NSString *header = [NSString stringWithFormat:@"\n--- Margin launched %@ ---\n", NSDate.date];
  [self appendLogData:[header dataUsingEncoding:NSUTF8StringEncoding]];
}

- (void)rotateLog {
  if (!self.logURL) return;
  @try {
    [self.logHandle synchronizeFile];
    [self.logHandle closeFile];
  } @catch (__unused NSException *exception) {
  }

  NSFileManager *manager = NSFileManager.defaultManager;
  NSURL *previousURL = [[self.logURL URLByDeletingLastPathComponent]
      URLByAppendingPathComponent:@"server.previous.log"];
  [manager removeItemAtURL:previousURL error:nil];
  if ([manager fileExistsAtPath:self.logURL.path]
      && ![manager moveItemAtURL:self.logURL toURL:previousURL error:nil]) {
    [manager removeItemAtURL:self.logURL error:nil];
  }
  [manager createFileAtPath:self.logURL.path contents:nil attributes:nil];
  self.logHandle = [NSFileHandle fileHandleForWritingAtPath:self.logURL.path];
  self.logBytes = 0;

  NSString *marker = [NSString stringWithFormat:@"--- Margin log continued %@ ---\n", NSDate.date];
  NSData *markerData = [marker dataUsingEncoding:NSUTF8StringEncoding];
  [self.logHandle writeData:markerData];
  self.logBytes = markerData.length;
}

- (void)appendLogData:(NSData *)data {
  if (!data.length || !self.logHandle) return;
  @try {
    NSData *payload = data;
    if (payload.length > MarginLogLimit) {
      payload = [payload subdataWithRange:NSMakeRange(payload.length - (NSUInteger)MarginLogLimit,
                                                       (NSUInteger)MarginLogLimit)];
    }
    if (self.logBytes + payload.length > MarginLogLimit) [self rotateLog];
    NSUInteger remaining = (NSUInteger)(MarginLogLimit - self.logBytes);
    if (payload.length > remaining) {
      payload = [payload subdataWithRange:NSMakeRange(payload.length - remaining, remaining)];
    }
    [self.logHandle writeData:payload];
    self.logBytes += payload.length;
  } @catch (__unused NSException *exception) {
  }
}

- (NSData *)redactedLogData:(NSData *)data {
  if (!data.length) return data;
  NSString *text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  if (!text) text = [[NSString alloc] initWithData:data encoding:NSISOLatin1StringEncoding];
  if (!text) return [@"[UNDECODABLE OUTPUT]" dataUsingEncoding:NSUTF8StringEncoding];
  if (self.sessionToken.length) {
    text = [text stringByReplacingOccurrencesOfString:self.sessionToken withString:@"[REDACTED]"];
  }
  NSError *error = nil;
  NSRegularExpression *sessionParameter = [NSRegularExpression
      regularExpressionWithPattern:@"([?&]session=)[^&\\s]+"
                         options:0
                           error:&error];
  if (sessionParameter) {
    text = [sessionParameter stringByReplacingMatchesInString:text
                                                       options:0
                                                         range:NSMakeRange(0, text.length)
                                                  withTemplate:@"$1[REDACTED]"];
  }
  return [text dataUsingEncoding:NSUTF8StringEncoding];
}

- (void)startBackend {
  self.generation += 1;
  NSUInteger generation = self.generation;
  self.readyURL = nil;
  self.contentOrigin = nil;
  self.restartAfterStop = NO;
  self.suppressTerminationError = NO;
  self.stdoutBuffer = [NSMutableData data];
  self.stderrBuffer = [NSMutableData data];
  [self showStatusWithTitle:@"Opening your library"
                     detail:@"Starting the local teaching service…"
                    loading:YES
                      retry:NO];

  self.workspaceURL = [self savedLibraryURL];
  if (!self.workspaceURL) {
    self.workspaceURL = [self promptForLibrary];
    if (!self.workspaceURL) {
      if (self.quitting) return;
      [self showStatusWithTitle:@"Choose a library to begin"
                         detail:@"Use Margin → Change Library… whenever you are ready."
                        loading:NO
                          retry:NO];
      return;
    }
    [self saveLibraryURL:self.workspaceURL];
  }

  NSURL *resourcesURL = NSBundle.mainBundle.resourceURL;
  NSURL *developmentRoot = [self developmentRootURL];
  if ([self isDevelopmentBuild] && !developmentRoot) {
    [self showStatusWithTitle:@"Margin Dev checkout not found"
                       detail:@"This development app points to a checkout that moved or was removed. Rebuild Margin Dev from its current location."
                      loading:NO
                        retry:NO];
    return;
  }
  NSURL *backendRoot = developmentRoot ?: resourcesURL;
  NSURL *serverURL = [backendRoot URLByAppendingPathComponent:@"app/server.mjs" isDirectory:NO];
  if (![NSFileManager.defaultManager isReadableFileAtPath:serverURL.path]) {
    [self showStatusWithTitle:@"Margin server not found"
                       detail:[NSString stringWithFormat:@"Expected %@", serverURL.path]
                      loading:NO
                        retry:YES];
    return;
  }

  NSURL *nodeURL = [self nodeExecutableURL];
  if (!nodeURL) {
    [self showStatusWithTitle:@"Margin runtime not found"
                       detail:developmentRoot
                           ? @"Margin Dev could not use its recorded Node.js executable or find Node.js on its fallback PATH. Rebuild Margin Dev from this checkout."
                           : @"The bundled Node.js runtime is missing. Reinstall Margin and try again."
                      loading:NO
                        retry:YES];
    return;
  }

  NSURL *teachSkillURL = [self teachSkillURL];
  NSURL *stateRootURL = [self stateRootURL];
  self.sessionToken = [self newSessionToken];
  if (!teachSkillURL || !stateRootURL || !self.sessionToken) {
    [self showStatusWithTitle:@"Margin could not prepare its local files"
                       detail:@"Check that the app is installed in a writable location, then try again."
                      loading:NO
                        retry:YES];
    return;
  }
  [self exportProviderIconsToStateRoot:stateRootURL];

  if (self.readyFileURL) [NSFileManager.defaultManager removeItemAtURL:self.readyFileURL error:nil];
  self.readyFileURL = [stateRootURL URLByAppendingPathComponent:
      [NSString stringWithFormat:@".backend-ready-%@", self.sessionToken] isDirectory:NO];
  [NSFileManager.defaultManager removeItemAtURL:self.readyFileURL error:nil];

  if (!self.logHandle) [self prepareLog];

  NSTask *task = [[NSTask alloc] init];
  NSPipe *stdoutPipe = [NSPipe pipe];
  NSPipe *stderrPipe = [NSPipe pipe];
  task.executableURL = nodeURL;
  task.arguments = @[serverURL.path];
  task.currentDirectoryURL = backendRoot;
  task.standardOutput = stdoutPipe;
  task.standardError = stderrPipe;

  NSMutableDictionary<NSString *, NSString *> *environment = [NSProcessInfo.processInfo.environment mutableCopy];
  environment[@"HOST"] = @"127.0.0.1";
  environment[@"PORT"] = @"0";
  environment[@"MARGIN_WORKSPACE_ROOT"] = self.workspaceURL.path;
  environment[@"MARGIN_TEACH_SKILL_PATH"] = teachSkillURL.path;
  environment[@"MARGIN_STATE_ROOT"] = stateRootURL.path;
  environment[@"MARGIN_SESSION_TOKEN"] = self.sessionToken;
  environment[@"MARGIN_READY_FILE"] = self.readyFileURL.path;
  environment[@"PATH"] = [self safePathEnvironment];
  environment[@"NO_COLOR"] = @"1";
  environment[@"FORCE_COLOR"] = @"0";
  task.environment = environment;

  self.serverTask = task;
  self.stdoutPipe = stdoutPipe;
  self.stderrPipe = stderrPipe;

  __weak typeof(self) weakSelf = self;
  stdoutPipe.fileHandleForReading.readabilityHandler = ^(NSFileHandle *handle) {
    NSData *data = handle.availableData;
    if (!data.length) handle.readabilityHandler = nil;
    [weakSelf consumeOutput:data isStdout:YES generation:generation];
  };
  stderrPipe.fileHandleForReading.readabilityHandler = ^(NSFileHandle *handle) {
    NSData *data = handle.availableData;
    if (!data.length) handle.readabilityHandler = nil;
    [weakSelf consumeOutput:data isStdout:NO generation:generation];
  };

  task.terminationHandler = ^(NSTask *finishedTask) {
    dispatch_async(dispatch_get_main_queue(), ^{
      [weakSelf backendDidExit:finishedTask generation:generation];
    });
  };

  NSError *launchError = nil;
  if (![task launchAndReturnError:&launchError]) {
    self.serverTask = nil;
    stdoutPipe.fileHandleForReading.readabilityHandler = nil;
    stderrPipe.fileHandleForReading.readabilityHandler = nil;
    [self showStatusWithTitle:@"Margin could not start"
                       detail:launchError.localizedDescription ?: @"The local teaching service could not be launched."
                      loading:NO
                        retry:YES];
    return;
  }

  [self pollReadyFileForGeneration:generation];

  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(15 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    typeof(self) self = weakSelf;
    if (!self || generation != self.generation || self.readyURL || !self.serverTask.running) return;
    self.suppressTerminationError = YES;
    [self.serverTask terminate];
    [self showStatusWithTitle:@"Margin took too long to start"
                       detail:@"Restart the app. If this keeps happening, open the server log for the exact error."
                      loading:NO
                        retry:YES];
  });
}

- (void)pollReadyFileForGeneration:(NSUInteger)generation {
  if (generation != self.generation || self.readyURL || !self.serverTask.running || !self.readyFileURL) return;
  NSData *data = [NSData dataWithContentsOfURL:self.readyFileURL options:0 error:nil];
  if (data.length) {
    NSString *line = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    [NSFileManager.defaultManager removeItemAtURL:self.readyFileURL error:nil];
    if (line.length) [self inspectReadyLine:[line stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet]
                                generation:generation];
    return;
  }

  __weak typeof(self) weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(50 * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
    [weakSelf pollReadyFileForGeneration:generation];
  });
}

- (void)consumeOutput:(NSData *)data isStdout:(BOOL)isStdout generation:(NSUInteger)generation {
  dispatch_async(self.logQueue, ^{
    if (generation != self.generation) return;

    NSMutableData *buffer = isStdout ? self.stdoutBuffer : self.stderrBuffer;
    [buffer appendData:data];
    const unsigned char newline = '\n';
    NSData *delimiter = [NSData dataWithBytes:&newline length:1];
    while (YES) {
      NSRange range = [buffer rangeOfData:delimiter options:0 range:NSMakeRange(0, buffer.length)];
      if (range.location == NSNotFound) break;
      NSData *lineData = [buffer subdataWithRange:NSMakeRange(0, range.location)];
      NSData *logData = [buffer subdataWithRange:NSMakeRange(0, NSMaxRange(range))];
      [buffer replaceBytesInRange:NSMakeRange(0, NSMaxRange(range)) withBytes:NULL length:0];
      [self appendLogData:[self redactedLogData:logData]];
      if (isStdout) {
        NSString *line = [[NSString alloc] initWithData:lineData encoding:NSUTF8StringEncoding];
        [self inspectReadyLine:line generation:generation];
      }
    }

    if (!data.length && buffer.length) {
      NSData *lineData = [buffer copy];
      [buffer setLength:0];
      [self appendLogData:[self redactedLogData:lineData]];
      if (isStdout) {
        NSString *line = [[NSString alloc] initWithData:lineData encoding:NSUTF8StringEncoding];
        [self inspectReadyLine:line generation:generation];
      }
    }
  });
}

- (void)inspectReadyLine:(NSString *)line generation:(NSUInteger)generation {
  if (![line hasPrefix:MarginReadyPrefix]) return;
  NSString *value = [[line substringFromIndex:MarginReadyPrefix.length]
      stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  NSURL *url = [NSURL URLWithString:value];
  if (!url) return;
  BOOL localHost = [url.host isEqualToString:@"127.0.0.1"] || [url.host isEqualToString:@"localhost"];
  NSURLComponents *components = [NSURLComponents componentsWithURL:url resolvingAgainstBaseURL:NO];
  NSString *session = nil;
  NSString *contentOriginValue = nil;
  BOOL knownQuery = YES;
  for (NSURLQueryItem *item in components.queryItems) {
    if ([item.name isEqualToString:@"session"]) session = item.value;
    else if ([item.name isEqualToString:@"contentOrigin"]) contentOriginValue = item.value;
    else knownQuery = NO;
  }

  NSURLComponents *contentComponents = contentOriginValue.length
      ? [NSURLComponents componentsWithString:contentOriginValue]
      : nil;
  NSURL *contentOrigin = contentComponents.URL;
  BOOL contentLocalHost = [contentOrigin.host isEqualToString:@"127.0.0.1"]
      || [contentOrigin.host isEqualToString:@"localhost"];
  NSString *contentPath = contentComponents.percentEncodedPath ?: @"";
  BOOL contentHasOriginPath = !contentPath.length || [contentPath isEqualToString:@"/"];
  BOOL contentMatchesAppOrigin = [contentOrigin.scheme.lowercaseString isEqualToString:url.scheme.lowercaseString]
      && [contentOrigin.host.lowercaseString isEqualToString:url.host.lowercaseString]
      && contentOrigin.port.integerValue == url.port.integerValue;
  BOOL validContentOrigin = [contentOrigin.scheme isEqualToString:@"http"]
      && contentLocalHost
      && contentOrigin.port.integerValue > 0
      && contentOrigin.port.integerValue <= 65535
      && !contentComponents.user.length
      && !contentComponents.password.length
      && contentHasOriginPath
      && !contentComponents.query.length
      && !contentComponents.fragment.length
      && !contentMatchesAppOrigin;
  BOOL validSession = !session.length || [session isEqualToString:self.sessionToken];
  if (![url.scheme isEqualToString:@"http"] || !localHost || url.port.integerValue <= 0
      || !knownQuery || !validSession || !validContentOrigin) return;

  // The native shell already owns the launch token. Add it only to the URL
  // loaded into WKWebView so the child process never needs to print the token.
  NSMutableArray<NSURLQueryItem *> *loadItems = [NSMutableArray array];
  for (NSURLQueryItem *item in components.queryItems) {
    if (![item.name isEqualToString:@"session"]) [loadItems addObject:item];
  }
  [loadItems addObject:[NSURLQueryItem queryItemWithName:@"session" value:self.sessionToken]];
  components.queryItems = loadItems;
  NSURL *loadURL = components.URL;
  if (!loadURL) return;

  dispatch_async(dispatch_get_main_queue(), ^{
    if (generation != self.generation || self.readyURL || !self.serverTask.running) return;
    if (self.readyFileURL) [NSFileManager.defaultManager removeItemAtURL:self.readyFileURL error:nil];
    self.readyURL = loadURL;
    self.contentOrigin = contentOrigin;
    [self showStatusWithTitle:@"Opening your library"
                       detail:@"Loading Margin…"
                      loading:YES
                        retry:NO];
    NSURLRequest *request = [NSURLRequest requestWithURL:loadURL
                                            cachePolicy:NSURLRequestReloadIgnoringLocalCacheData
                                        timeoutInterval:20];
    [self.webView loadRequest:request];
  });
}

- (void)backendDidExit:(NSTask *)task generation:(NSUInteger)generation {
  if (generation != self.generation || task != self.serverTask) return;
  self.stdoutPipe.fileHandleForReading.readabilityHandler = nil;
  self.stderrPipe.fileHandleForReading.readabilityHandler = nil;
  if (self.readyFileURL) [NSFileManager.defaultManager removeItemAtURL:self.readyFileURL error:nil];
  self.serverTask = nil;

  if (self.quitting) {
    if (self.terminationReplyPending) {
      self.terminationReplyPending = NO;
      [NSApp replyToApplicationShouldTerminate:YES];
    }
    return;
  }

  if (self.restartAfterStop) {
    self.restartAfterStop = NO;
    [self startBackend];
    return;
  }

  if (self.suppressTerminationError) {
    self.suppressTerminationError = NO;
    return;
  }

  NSString *detail = [NSString stringWithFormat:@"The local teaching service stopped (status %d). Open the log for details.",
                                                task.terminationStatus];
  [self showStatusWithTitle:@"Margin stopped" detail:detail loading:NO retry:YES];
}

- (IBAction)retryBackend:(id)sender {
  (void)sender;
  if (self.serverTask.running) {
    self.restartAfterStop = YES;
    self.suppressTerminationError = YES;
    [self.serverTask terminate];
  } else {
    [self startBackend];
  }
}

- (IBAction)changeLibrary:(id)sender {
  (void)sender;
  NSURL *libraryURL = [self promptForLibrary];
  if (!libraryURL) return;
  [self saveLibraryURL:libraryURL];
  self.workspaceURL = libraryURL;
  if (self.serverTask.running) {
    self.restartAfterStop = YES;
    self.suppressTerminationError = YES;
    [self.serverTask terminate];
  } else {
    [self startBackend];
  }
}

- (IBAction)showLog:(id)sender {
  (void)sender;
  if (self.logURL) [NSWorkspace.sharedWorkspace activateFileViewerSelectingURLs:@[self.logURL]];
}

- (BOOL)URL:(NSURL *)url sharesOriginWithURL:(NSURL *)origin {
  if (!origin || !url) return NO;
  BOOL sameScheme = [url.scheme.lowercaseString isEqualToString:origin.scheme.lowercaseString];
  BOOL sameHost = [url.host.lowercaseString isEqualToString:origin.host.lowercaseString];
  NSInteger urlPort = url.port ? url.port.integerValue : ([url.scheme.lowercaseString isEqualToString:@"https"] ? 443 : 80);
  NSInteger originPort = origin.port ? origin.port.integerValue
                                     : ([origin.scheme.lowercaseString isEqualToString:@"https"] ? 443 : 80);
  return sameScheme && sameHost && urlPort == originPort;
}

- (void)webView:(WKWebView *)webView
    decidePolicyForNavigationAction:(WKNavigationAction *)navigationAction
                   decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
  NSURL *url = navigationAction.request.URL;
  BOOL appOrigin = [self URL:url sharesOriginWithURL:self.readyURL];
  BOOL contentOrigin = [self URL:url sharesOriginWithURL:self.contentOrigin];
  BOOL aboutBlank = [url.absoluteString.lowercaseString isEqualToString:@"about:blank"];

  if (appOrigin) {
    if (!navigationAction.targetFrame) {
      [webView loadRequest:navigationAction.request];
      decisionHandler(WKNavigationActionPolicyCancel);
    } else {
      decisionHandler(WKNavigationActionPolicyAllow);
    }
    return;
  }

  if (aboutBlank || (contentOrigin && navigationAction.targetFrame && !navigationAction.targetFrame.mainFrame)) {
    decisionHandler(WKNavigationActionPolicyAllow);
    return;
  }

  if (contentOrigin) {
    decisionHandler(WKNavigationActionPolicyCancel);
    return;
  }

  NSString *scheme = url.scheme.lowercaseString;
  BOOL externalScheme = [scheme isEqualToString:@"http"]
      || [scheme isEqualToString:@"https"]
      || [scheme isEqualToString:@"mailto"];
  if (navigationAction.navigationType == WKNavigationTypeLinkActivated && externalScheme) {
    [NSWorkspace.sharedWorkspace openURL:url];
  }
  decisionHandler(WKNavigationActionPolicyCancel);
}

- (void)webView:(WKWebView *)webView
    runJavaScriptConfirmPanelWithMessage:(NSString *)message
                         initiatedByFrame:(WKFrameInfo *)frame
                       completionHandler:(void (^)(BOOL result))completionHandler {
  (void)webView;
  if (!frame.mainFrame) {
    completionHandler(NO);
    return;
  }

  NSAlert *alert = [[NSAlert alloc] init];
  alert.alertStyle = NSAlertStyleWarning;
  alert.messageText = message.length ? message : @"Delete this note?";
  alert.informativeText = @"This cannot be undone.";
  NSButton *deleteButton = [alert addButtonWithTitle:@"Delete"];
  deleteButton.hasDestructiveAction = YES;
  [alert addButtonWithTitle:@"Cancel"];
  [alert beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse response) {
    completionHandler(response == NSAlertFirstButtonReturn);
  }];
}

- (void)webView:(WKWebView *)webView
    runOpenPanelWithParameters:(WKOpenPanelParameters *)parameters
              initiatedByFrame:(WKFrameInfo *)frame
             completionHandler:(void (^)(NSArray<NSURL *> *URLs))completionHandler {
  (void)webView;
  if (!frame.mainFrame) {
    completionHandler(nil);
    return;
  }

  NSOpenPanel *panel = [NSOpenPanel openPanel];
  panel.canChooseFiles = YES;
  panel.canChooseDirectories = NO;
  panel.allowsMultipleSelection = parameters.allowsMultipleSelection;
  panel.resolvesAliases = YES;
  panel.message = @"Choose a PNG, JPEG, or WebP image.";
  [panel beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse response) {
    completionHandler(response == NSModalResponseOK ? panel.URLs : nil);
  }];
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
  (void)webView;
  (void)navigation;
  self.statusView.hidden = YES;
  self.webView.hidden = NO;
  [self.progressIndicator stopAnimation:nil];
}

- (void)webView:(WKWebView *)webView
    didFailProvisionalNavigation:(WKNavigation *)navigation
                         withError:(NSError *)error {
  (void)webView;
  (void)navigation;
  [self showStatusWithTitle:@"Margin could not load"
                     detail:error.localizedDescription ?: @"The local page could not be opened."
                    loading:NO
                      retry:YES];
}

- (void)webView:(WKWebView *)webView
    didFailNavigation:(WKNavigation *)navigation
             withError:(NSError *)error {
  [self webView:webView didFailProvisionalNavigation:navigation withError:error];
}

@end

int main(int argc, const char *argv[]) {
  (void)argc;
  (void)argv;
  @autoreleasepool {
    NSApplication *application = [NSApplication sharedApplication];
    MarginAppDelegate *delegate = [[MarginAppDelegate alloc] init];
    application.delegate = delegate;
    [application run];
  }
  return 0;
}
